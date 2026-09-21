import { Router, urlencoded, type Request, type Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { ID_RE, isValidEmail, normalizeEmail, sha256Hex, TOKEN_RE } from '../crypto.js';
import { now } from '../db.js';
import { t } from '../i18n.js';
import { log } from '../log.js';
import { accessCodeMail } from '../mail/templates.js';
import {
  ChallengeRateError, createAccessSession, createChallenge, destroyAccessSession, verifyChallenge,
} from '../services/access.js';
import { audit } from '../services/audit.js';
import { getItem, listItemsForRecipient } from '../services/items.js';
import { emailMatches, openingsLeft, registerOpen, resolveToken, touchLink, type ResolvedLink } from '../services/links.js';
import { StorageNotFoundError } from '../storage/index.js';
import { sendAttachment } from './admin.js';
import { ACCESS_COOKIE, type AppContext } from './context.js';
import {
  accessCookie, accessMiddleware, clearCookie, flowMiddleware, LINK_STATE_MESSAGES, publicFormGuard, publicLimiter, tokenFailureLimiter, unlockLimiter,
} from './middleware.js';
import { deliverCodePage, deliverEmailPage, deliverPackagePage, linkUnavailablePage } from './views/deliver.js';

/**
 * Everything a recipient touches lives under /d/<token>:
 *
 *   GET  /d/<token>            e-mail form → code form → the delivery itself
 *   POST /d/<token>/email      the address must equal the one the link was issued for
 *   POST /d/<token>/code       the one-time code that was mailed to that address
 *   GET  /d/<token>/files/<id> download, only with a live recipient session
 *
 * Holding the link is not access: it only decides *which* delivery is being
 * unlocked. The address proves who the visitor claims to be, and the code
 * proves they can read that mailbox.
 */
export function deliverRouter(ctx: AppContext): Router {
  const r = Router();
  const tokenFailures = tokenFailureLimiter(ctx);
  const unlockFailures = unlockLimiter(ctx);

  r.use('/d', publicLimiter(ctx));
  r.use('/d', urlencoded({ extended: false, limit: '16kb' }));
  r.use('/d', flowMiddleware(ctx));
  r.use('/d', accessMiddleware(ctx));

  const unavailable = (req: Request, res: Response, resolved: ResolvedLink | null): boolean => {
    if (!resolved) {
      res.status(404).type('html').send(linkUnavailablePage(req.lang, t(req.lang, 'link.invalid.title'), t(req.lang, 'link.invalid')));
      return true;
    }
    if (resolved.state !== 'active') {
      // An exhausted link still lets a session that is already open finish its downloads.
      if (resolved.state === 'exhausted' && req.access?.linkId === resolved.link.id) return false;
      const m = LINK_STATE_MESSAGES[resolved.state];
      res.status(m.status).type('html').send(linkUnavailablePage(req.lang, t(req.lang, 'link.unavailable.title'), t(req.lang, m.message)));
      return true;
    }
    return false;
  };

  /** Resolves the token, or answers with the right "nothing to see here" page. */
  function load(req: Request, res: Response): ResolvedLink | null {
    const token = String(req.params.token ?? '');
    const resolved = TOKEN_RE.test(token) ? resolveToken(ctx.db, token) : null;
    // These pages speak the language the link was issued in, because that is the
    // language the administrator knows this recipient reads. A visitor who picks
    // one in the footer keeps it: their own choice outranks the assumption.
    if (resolved && !req.langExplicit) req.lang = resolved.link.lang;
    if (unavailable(req, res, resolved)) return null;
    req.delivery = resolved!;
    req.deliveryToken = token;
    return resolved;
  }

  const base = (req: Request): string => `/d/${req.deliveryToken}`;

  /**
   * The code form posts one `code` field per digit box, so a browser sends six
   * of them; a client that sends the code as one string still works. Joining is
   * all it takes — `verifyChallenge` normalises and length-checks afterwards.
   */
  function codeFromBody(body: unknown): string {
    const v = (body as Record<string, unknown> | undefined)?.code;
    const joined = Array.isArray(v) ? v.map((part) => (typeof part === 'string' ? part : '')).join('') : typeof v === 'string' ? v : '';
    return joined.slice(0, 64);
  }

  function pendingChallenge(linkId: string, flowToken: string): boolean {
    const row = ctx.db.prepare(
      `SELECT 1 AS present FROM challenges WHERE link_id = ? AND flow_hash = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(linkId, sha256Hex(flowToken), now()) as { present: number } | undefined;
    return row !== undefined;
  }

  // ---- the page itself -----------------------------------------------------
  r.get('/d/:token', tokenFailures, (req, res) => {
    const resolved = load(req, res);
    if (!resolved) return;
    res.setHeader('Cache-Control', 'no-store');
    const view = { lang: req.lang, path: req.originalUrl, flowToken: req.flowToken!, base: base(req) };

    if (req.access?.linkId === resolved.link.id) {
      res.type('html').send(deliverPackagePage({
        ...view,
        case: resolved.case,
        link: resolved.link,
        items: listItemsForRecipient(ctx.db, resolved.case.id),
        opensLeft: openingsLeft(resolved.link),
        sessionExpiresAt: req.access.expiresAt,
      }));
      return;
    }
    touchLink(ctx.db, resolved.link.id);
    if (pendingChallenge(resolved.link.id, req.flowToken!)) {
      res.type('html').send(deliverCodePage({ ...view, minutes: Math.round(ctx.cfg.accessCodeTtlMs / 60_000) }));
      return;
    }
    res.type('html').send(deliverEmailPage(view));
  });

  // ---- step 1: the address -------------------------------------------------
  r.post('/d/:token/email', unlockFailures, publicFormGuard(ctx), (req, res, next) => {
    const resolved = load(req, res);
    if (!resolved) return;
    const view = { lang: req.lang, path: base(req), flowToken: req.flowToken!, base: base(req) };
    const typed = normalizeEmail(String((req.body as Record<string, unknown>).email ?? ''));
    if (!isValidEmail(typed)) {
      res.status(400).type('html').send(deliverEmailPage({ ...view, error: t(req.lang, 'deliver.email.invalid') }));
      return;
    }
    const minutes = Math.round(ctx.cfg.accessCodeTtlMs / 60_000);
    // A wrong address gets exactly the same page as a right one: the link must
    // not become an oracle for "who is this delivery addressed to".
    const codePage = (extra: Record<string, unknown> = {}, status = 200) =>
      res.status(status).type('html').send(deliverCodePage({ ...view, minutes, ...extra }));

    if (!emailMatches(resolved.link, typed)) {
      audit(ctx.db, { actorType: 'recipient', action: 'access.email_mismatch', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip });
      codePage();
      return;
    }

    let created;
    try {
      created = createChallenge(ctx.db, ctx.cfg, { linkId: resolved.link.id, flowToken: req.flowToken!, ip: req.ip ?? null });
    } catch (err) {
      if (err instanceof ChallengeRateError) {
        audit(ctx.db, { actorType: 'recipient', action: 'access.rate_limited', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip });
        res.status(429).type('html').send(deliverEmailPage({ ...view, error: t(req.lang, 'deliver.too_many') }));
        return;
      }
      throw err;
    }

    // The message is written in the recipient's language, which is a property of
    // the link, not of the browser that happens to be asking for the code.
    ctx.mailer.send(accessCodeMail({
      lang: resolved.link.lang, to: resolved.link.recipient_email,
      brand: ctx.cfg.brand, publicUrl: ctx.cfg.publicUrl,
      caseName: resolved.case.name, code: created.code, ttlMinutes: minutes,
    })).then(() => {
      audit(ctx.db, { actorType: 'recipient', action: 'access.code_sent', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip });
      codePage();
    }).catch((err: unknown) => {
      log.warn('code mail failed', { linkId: resolved.link.id, err: err as Error });
      audit(ctx.db, { actorType: 'recipient', action: 'access.code_send_failed', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip });
      res.status(502).type('html').send(deliverEmailPage({ ...view, error: t(req.lang, 'deliver.mail_failed') }));
    }).catch(next);
  });

  // ---- step 2: the code ----------------------------------------------------
  r.post('/d/:token/code', unlockFailures, publicFormGuard(ctx), (req, res) => {
    const resolved = load(req, res);
    if (!resolved) return;
    const view = { lang: req.lang, path: base(req), flowToken: req.flowToken!, base: base(req) };
    const minutes = Math.round(ctx.cfg.accessCodeTtlMs / 60_000);
    const result = verifyChallenge(ctx.db, ctx.cfg, {
      linkId: resolved.link.id, flowToken: req.flowToken!, code: codeFromBody(req.body),
    });

    if (result.status === 'invalid') {
      audit(ctx.db, { actorType: 'recipient', action: 'access.code_failed', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip, details: { attempts_left: result.attemptsLeft } });
      res.status(401).type('html').send(deliverCodePage({ ...view, minutes, error: t(req.lang, 'deliver.code.invalid'), attemptsLeft: result.attemptsLeft, notice: null }));
      return;
    }
    if (result.status === 'gone') {
      audit(ctx.db, { actorType: 'recipient', action: 'access.code_expired', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip });
      res.status(401).type('html').send(deliverEmailPage({ ...view, error: t(req.lang, 'deliver.code.expired') }));
      return;
    }

    // Counting the opening is the same statement that enforces the limit, so two
    // codes redeemed at once can never both slip past the last allowed opening.
    if (!registerOpen(ctx.db, resolved.link.id)) {
      res.status(403).type('html').send(linkUnavailablePage(req.lang, t(req.lang, 'link.unavailable.title'), t(req.lang, 'link.exhausted')));
      return;
    }
    const { sessionId, session } = createAccessSession(ctx.db, ctx.cfg, resolved.link.id, req.ip ?? null);
    audit(ctx.db, { actorType: 'recipient', actorId: resolved.link.id, action: 'access.granted', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip, details: { expires_at: session.expiresAt } });
    res.setHeader('Set-Cookie', accessCookie(ctx, sessionId, Math.floor(ctx.cfg.accessSessionTtlMs / 1000)));
    res.redirect(303, base(req));
  });

  /** "Start over": drops the pending code so the address form comes back. */
  r.post('/d/:token/restart', publicFormGuard(ctx), (req, res) => {
    const resolved = load(req, res);
    if (!resolved) return;
    ctx.db.prepare('UPDATE challenges SET consumed_at = ? WHERE link_id = ? AND flow_hash = ? AND consumed_at IS NULL')
      .run(now(), resolved.link.id, sha256Hex(req.flowToken!));
    res.redirect(303, base(req));
  });

  r.post('/d/:token/close', publicFormGuard(ctx), (req, res) => {
    const resolved = load(req, res);
    if (!resolved) return;
    if (req.accessId) {
      destroyAccessSession(ctx.db, req.accessId);
      audit(ctx.db, { actorType: 'recipient', actorId: resolved.link.id, action: 'access.closed', caseId: resolved.case.id, linkId: resolved.link.id, ip: req.ip });
    }
    res.setHeader('Set-Cookie', clearCookie(ACCESS_COOKIE));
    res.status(200).type('html').send(deliverEmailPage({
      lang: req.lang, path: base(req), flowToken: req.flowToken!, base: base(req), notice: t(req.lang, 'deliver.session_over'),
    }));
  });

  // ---- downloads -----------------------------------------------------------
  r.get('/d/:token/files/:itemId', async (req, res) => {
    const resolved = load(req, res);
    if (!resolved) return;
    if (req.access?.linkId !== resolved.link.id) {
      res.redirect(303, base(req));
      return;
    }
    const itemId = typeof req.params.itemId === 'string' && ID_RE.test(req.params.itemId) ? req.params.itemId : null;
    const item = itemId ? getItem(ctx.db, itemId) : null;
    // Items belong to the case, so an id from another case is simply not found.
    if (!item || item.case_id !== resolved.case.id || item.kind !== 'file' || item.status !== 'ready') {
      res.status(404).type('html').send(linkUnavailablePage(req.lang, t(req.lang, 'error.not_found.title'), t(req.lang, 'error.item_missing')));
      return;
    }
    let stream;
    try {
      stream = await ctx.storage.get(item.id);
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        res.status(410).type('html').send(linkUnavailablePage(req.lang, t(req.lang, 'error.storage_missing.title'), t(req.lang, 'error.item_missing')));
        return;
      }
      throw err;
    }
    audit(ctx.db, { actorType: 'recipient', actorId: resolved.link.id, action: 'item.download', caseId: item.case_id, linkId: resolved.link.id, itemId: item.id, ip: req.ip, details: { name: item.title } });
    sendAttachment(res, item.title, item.size);
    try {
      await pipeline(stream, res);
    } catch (err) {
      log.debug('download interrupted', { itemId: item.id, err: err as Error });
    }
  });

  return r;
}
