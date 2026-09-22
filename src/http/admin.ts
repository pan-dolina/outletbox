import { Router, urlencoded, type Request, type Response } from 'express';
import { create as contentDisposition } from 'content-disposition';
import QRCode from 'qrcode';
import { pipeline } from 'node:stream/promises';
import { ID_RE } from '../crypto.js';
import { log } from '../log.js';
import { audit, listAudit } from '../services/audit.js';
import {
  authenticate, beginTotpEnrolment, changeAdminPassword, confirmTotpEnrolment, createSession, destroyOtherSessions, destroySession,
  disableTotp, MAX_TOTP_ATTEMPTS, pendingTotpSecret, regenerateRecoveryCodes, remainingRecoveryCodes, totpLockedUntil, verifySessionTotp,
} from '../services/auth.js';
import { destroyAccessSessionsForCase, destroyAccessSessionsForLink } from '../services/access.js';
import { createCase, getCase, listCases, updateCase } from '../services/cases.js';
import { discardUploadData } from '../services/cleanup.js';
import {
  completeUpload, createNote, failUpload, getItem, listItemsForCase, LimitError, markDeleted, sanitizeFilename, startUpload,
} from '../services/items.js';
import { createLink, getLink, listLinksForCase, revokeLink, rotateLinkToken } from '../services/links.js';
import { StorageLimitError, StorageNotFoundError } from '../storage/index.js';
import { otpauthUri } from '../totp.js';
import { t, type MessageKey } from '../i18n.js';
import type { AppContext } from './context.js';
import { SESSION_COOKIE } from './context.js';
import { clearCookie, csrfProtect, loginLimiter, requireAdmin, sessionCookie } from './middleware.js';
import { createTusServer, tusHandler } from './tus.js';
import { adminNav, auditPage, casePage, casesPage, errorPage, loginPage, type AdminViewContext } from './views/admin.js';
import { securityPage, totpLoginPage, type SecurityPageData } from './views/security.js';

function viewCtx(req: Request): AdminViewContext {
  return { lang: req.lang, csrfToken: req.session!.csrfToken, username: req.session!.admin.username, path: req.originalUrl };
}

function sendError(req: Request, res: Response, titleKey: MessageKey, messageKey: MessageKey, status = 404): void {
  const e = errorPage(req.lang, t(req.lang, titleKey), t(req.lang, messageKey), status, req.originalUrl, '/admin');
  res.status(e.status).type('html').send(e.body);
}

function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

function validId(id: string | undefined): string | null {
  return id && ID_RE.test(id) ? id : null;
}

/** Content-Length as a number, or null when absent/chunked. */
function declaredLength(req: Request): number | null {
  if (req.headers['transfer-encoding']) return null;
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function adminRouter(ctx: AppContext): Router {
  const r = Router();
  // Forms only: an upload must reach storage as a stream, whatever Content-Type
  // the client happened to set (curl --data-binary announces urlencoded, and the
  // parser would silently swallow the body).
  const forms = urlencoded({ extended: false, limit: '256kb' });
  r.use((req, res, next) => (req.path.startsWith('/api/') ? next() : forms(req, res, next)));
  // One budget for password and second-factor failures.
  const loginFailures = loginLimiter(ctx);
  const tus = createTusServer(ctx);

  // ---- login / logout ----------------------------------------------------
  r.get('/login', (req, res) => {
    if (req.session) return res.redirect(req.session.totpVerified ? '/admin' : '/admin/totp');
    res.type('html').send(loginPage(req.lang, {}));
  });

  r.post('/login', loginFailures, (req, res) => {
    const username = field(req, 'username').trim();
    const password = field(req, 'password');
    const admin = username && password ? authenticate(ctx.db, username, password) : null;
    if (!admin) {
      // The attempted username is deliberately not recorded: that field routinely receives passwords typed into the wrong box.
      audit(ctx.db, { actorType: 'system', action: 'admin.login_failed', ip: req.ip });
      res.status(401).type('html').send(loginPage(req.lang, { error: t(req.lang, 'login.failed') }));
      return;
    }
    // A fresh session id on every login (no fixation); it is only "pending" until the second factor passes.
    const { sessionId } = createSession(ctx.db, admin, ctx.cfg.sessionTtlMs);
    res.setHeader('Set-Cookie', sessionCookie(ctx, sessionId, Math.floor(ctx.cfg.sessionTtlMs / 1000)));
    if (admin.totp_enabled) {
      audit(ctx.db, { actorType: 'admin', actorId: admin.id, action: 'admin.login_password', ip: req.ip });
      res.redirect(303, '/admin/totp');
      return;
    }
    audit(ctx.db, { actorType: 'admin', actorId: admin.id, action: 'admin.login', ip: req.ip });
    res.redirect(303, ctx.cfg.adminRequireTotp ? '/admin/security' : '/admin');
  });

  // Everything below needs at least a password-authenticated session and a CSRF token for state changes.
  r.use(requireAdmin({ verified: false }));
  r.use(csrfProtect(ctx));

  r.post('/logout', (req, res) => {
    if (req.sessionId) destroySession(ctx.db, req.sessionId);
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'admin.logout', ip: req.ip });
    res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE));
    res.redirect(303, '/admin/login');
  });

  // ---- second factor -------------------------------------------------------
  r.get('/totp', (req, res) => {
    if (req.session!.totpVerified) return res.redirect('/admin');
    const lockedUntil = totpLockedUntil(ctx.db, req.session!.admin.id);
    res.type('html').send(totpLoginPage(req.lang, { csrfToken: req.session!.csrfToken, lockedUntil: lockedUntil ?? undefined }));
  });

  r.post('/totp', loginFailures, (req, res) => {
    const session = req.session!;
    if (session.totpVerified) return res.redirect(303, '/admin');
    const result = verifySessionTotp(ctx.db, req.sessionId!, field(req, 'code'), ctx.cfg.sessionTtlMs);
    if (result.status === 'ok') {
      audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.login', ip: req.ip, details: { second_factor: true } });
      // Fresh session id for the privileged session.
      res.setHeader('Set-Cookie', sessionCookie(ctx, result.sessionId, Math.floor(ctx.cfg.sessionTtlMs / 1000)));
      res.redirect(303, '/admin');
      return;
    }
    if (result.status === 'locked') {
      audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.totp_locked', ip: req.ip, details: { account_locked_until: result.accountLockedUntil } });
      res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE));
      res.status(401).type('html').send(loginPage(req.lang, { error: t(req.lang, result.accountLockedUntil ? 'login.account_locked' : 'login.too_many_codes') }));
      return;
    }
    audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.totp_failed', ip: req.ip });
    res.status(401).type('html').send(totpLoginPage(req.lang, { csrfToken: session.csrfToken, error: t(req.lang, 'totp.invalid'), attemptsLeft: MAX_TOTP_ATTEMPTS - session.totpAttempts - 1 }));
  });

  // From here on the second factor must have been passed.
  r.use(requireAdmin({ verified: true }));

  // ---- security settings ------------------------------------------------
  async function renderSecurity(req: Request, res: Response, extra: Partial<SecurityPageData> = {}, status = 200): Promise<void> {
    const session = req.session!;
    const pending = session.admin.totp_enabled ? null : pendingTotpSecret(ctx.db, session.admin.id);
    let enrol: SecurityPageData['enrol'];
    if (pending) {
      const uri = otpauthUri({ secret: pending, account: session.admin.username, issuer: ctx.cfg.brand.name });
      const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 });
      enrol = { qrSvg, secret: pending, uri };
    }
    res.status(status).type('html').send(securityPage({
      lang: req.lang, csrfToken: session.csrfToken, username: session.admin.username, nav: adminNav(viewCtx(req)),
      totpEnabled: session.admin.totp_enabled, totpRequired: ctx.cfg.adminRequireTotp, issuer: ctx.cfg.brand.name,
      recoveryLeft: session.admin.totp_enabled ? remainingRecoveryCodes(ctx.db, session.admin.id) : 0,
      enrol, ...extra,
    }));
  }

  r.get('/security', (req, res, next) => { renderSecurity(req, res).catch(next); });

  r.post('/security/password', (req, res, next) => {
    const session = req.session!;
    const newPassword = field(req, 'new_password');
    if (newPassword !== field(req, 'new_password_confirm')) {
      renderSecurity(req, res, { error: t(req.lang, 'security.password.mismatch') }, 400).catch(next);
      return;
    }
    try {
      if (!changeAdminPassword(ctx.db, session.admin.id, field(req, 'current_password'), newPassword)) {
        renderSecurity(req, res, { error: t(req.lang, 'security.password.invalid_current') }, 400).catch(next);
        return;
      }
    } catch (err) {
      renderSecurity(req, res, { error: (err as Error).message }, 400).catch(next);
      return;
    }
    destroyOtherSessions(ctx.db, session.admin.id, req.sessionId!);
    audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.password_changed', ip: req.ip });
    renderSecurity(req, res, { ok: t(req.lang, 'security.password.changed') }).catch(next);
  });

  r.post('/security/totp/begin', (req, res, next) => {
    try {
      beginTotpEnrolment(ctx.db, req.session!.admin.id);
      renderSecurity(req, res).catch(next);
    } catch (err) {
      renderSecurity(req, res, { error: (err as Error).message }, 400).catch(next);
    }
  });

  r.post('/security/totp/confirm', (req, res, next) => {
    const session = req.session!;
    const codes = confirmTotpEnrolment(ctx.db, session.admin.id, field(req, 'code'));
    if (!codes) {
      renderSecurity(req, res, { error: t(req.lang, 'security.msg.code_mismatch') }, 400).catch(next);
      return;
    }
    // Other sessions of this admin did not prove the second factor: end them.
    destroyOtherSessions(ctx.db, session.admin.id, req.sessionId!);
    session.admin.totp_enabled = true;
    audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.totp_enabled', ip: req.ip });
    renderSecurity(req, res, { ok: t(req.lang, 'security.msg.enabled'), recoveryCodes: codes }).catch(next);
  });

  r.post('/security/totp/recovery', (req, res, next) => {
    const session = req.session!;
    const codes = regenerateRecoveryCodes(ctx.db, session.admin.id, field(req, 'code'));
    if (!codes) {
      renderSecurity(req, res, { error: t(req.lang, 'security.msg.invalid_code') }, 400).catch(next);
      return;
    }
    audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.recovery_codes_regenerated', ip: req.ip });
    renderSecurity(req, res, { ok: t(req.lang, 'security.msg.regenerated'), recoveryCodes: codes }).catch(next);
  });

  r.post('/security/totp/disable', (req, res, next) => {
    const session = req.session!;
    if (ctx.cfg.adminRequireTotp) {
      renderSecurity(req, res, { error: t(req.lang, 'security.msg.required') }, 400).catch(next);
      return;
    }
    if (!disableTotp(ctx.db, session.admin.id, field(req, 'code'), req.sessionId!)) {
      audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.totp_failed', ip: req.ip, details: { context: 'disable' } });
      renderSecurity(req, res, { error: t(req.lang, 'security.msg.invalid_code') }, 400).catch(next);
      return;
    }
    session.admin.totp_enabled = false;
    audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.totp_disabled', ip: req.ip });
    renderSecurity(req, res, { ok: t(req.lang, 'security.msg.disabled') }).catch(next);
  });

  // With ADMIN_REQUIRE_TOTP, admins without a second factor may only reach the security page.
  r.use((req, res, next) => {
    if (ctx.cfg.adminRequireTotp && !req.session!.admin.totp_enabled) {
      if (req.method === 'GET') return res.redirect(302, '/admin/security');
      res.status(403).type('text/plain').send('TOTP enrolment required');
      return;
    }
    next();
  });

  // ---- uploads (browser: tus; scripts: a plain streaming PUT) --------------
  r.all('/api/tus', tusHandler(tus));
  r.all('/api/tus/:id', tusHandler(tus));

  r.put('/api/cases/:caseId/upload/:name', (req, res, next) => { directUpload(req, res).catch(next); });
  r.post('/api/cases/:caseId/upload/:name', (req, res, next) => { directUpload(req, res).catch(next); });

  async function directUpload(req: Request, res: Response): Promise<void> {
    const caseId = validId(typeof req.params.caseId === 'string' ? req.params.caseId : undefined);
    const c = caseId ? getCase(ctx.db, caseId) : null;
    if (!c) { res.status(404).json({ error: 'case_not_found' }); return; }
    if (c.status !== 'open') { res.status(403).json({ error: 'case_closed' }); return; }
    const originalName = sanitizeFilename(typeof req.params.name === 'string' ? safeDecode(req.params.name) : '');
    const declared = declaredLength(req);
    const admin = req.session!.admin.id;
    // Resolve the address now: once a streaming upload fails, the socket (and
    // with it req.ip) may already be gone when the audit line is written.
    const ip = req.ip ?? null;

    let started;
    try {
      started = startUpload(ctx.db, ctx.cfg, { caseId: c.id, originalName, uploadKind: 'direct', declaredSize: declared, adminId: admin });
    } catch (err) {
      if (err instanceof LimitError) {
        res.status(413).json({ error: err.code, message: err.message, limit: err.limit });
        req.resume();
        return;
      }
      throw err;
    }
    const { item, maxBytes } = started;
    audit(ctx.db, { actorType: 'admin', actorId: admin, action: 'upload.start', caseId: c.id, itemId: item.id, ip, details: { kind: 'direct', size: declared } });
    if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();

    let result;
    try {
      result = await ctx.storage.put(item.id, req, { maxBytes });
      if (!req.complete) throw new Error('request ended before body was complete');
      if (declared != null && result.size !== declared) throw new Error(`received ${result.size} bytes, Content-Length was ${declared}`);
    } catch (err) {
      failUpload(ctx.db, item.id, 'aborted');
      await ctx.storage.delete(item.id).catch(() => undefined);
      // The request stream was torn down mid-body: this connection must not be reused for another request.
      if (!res.headersSent) res.setHeader('Connection', 'close');
      if (err instanceof StorageLimitError) {
        audit(ctx.db, { actorType: 'admin', actorId: admin, action: 'upload.rejected', caseId: c.id, itemId: item.id, ip, details: { reason: 'limit', maxBytes } });
        res.status(413).json({ error: 'file_too_large', message: `Upload exceeded the allowed ${maxBytes} bytes`, limit: maxBytes });
        req.resume();
        return;
      }
      audit(ctx.db, { actorType: 'admin', actorId: admin, action: 'upload.aborted', caseId: c.id, itemId: item.id, ip, details: { reason: (err as Error).message } });
      log.info('direct upload aborted', { itemId: item.id, reason: (err as Error).message });
      if (!res.headersSent && !req.socket.destroyed) res.status(400).json({ error: 'upload_incomplete', message: 'Connection closed before the upload completed' });
      return;
    }

    completeUpload(ctx.db, item.id, result.size, result.sha256);
    audit(ctx.db, { actorType: 'admin', actorId: admin, action: 'upload.complete', caseId: c.id, itemId: item.id, ip, details: { kind: 'direct', size: result.size, name: originalName } });
    res.status(201).json({ id: item.id, name: originalName, size: result.size, sha256: result.sha256, status: 'ready' });
  }

  // ---- cases -------------------------------------------------------------
  r.get('/', (req, res) => {
    res.type('html').send(casesPage(viewCtx(req), listCases(ctx.db)));
  });

  r.post('/cases', (req, res) => {
    try {
      const c = createCase(ctx.db, { name: field(req, 'name'), description: field(req, 'description') });
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'case.create', caseId: c.id, ip: req.ip, details: { name: c.name } });
      res.redirect(303, `/admin/cases/${c.id}`);
    } catch (err) {
      res.status(400).type('html').send(casesPage(viewCtx(req), listCases(ctx.db), { error: (err as Error).message }));
    }
  });

  function renderCase(req: Request, res: Response, caseId: string, extra: { error?: string; ok?: string; newLink?: { label: string; url: string } } = {}, status = 200): void {
    const c = getCase(ctx.db, caseId);
    if (!c) return sendError(req, res, 'error.not_found.title', 'error.case_missing');
    res.status(status).type('html').send(casePage(viewCtx(req), { case: c, links: listLinksForCase(ctx.db, c.id), items: listItemsForCase(ctx.db, c.id), cfg: ctx.cfg, ...extra }));
  }

  r.get('/cases/:id', (req, res) => {
    const id = validId(req.params.id);
    if (!id) return renderCase(req, res, '');
    renderCase(req, res, id);
  });

  r.post('/cases/:id', (req, res) => {
    const id = validId(req.params.id);
    if (!id) return renderCase(req, res, '');
    try {
      const c = updateCase(ctx.db, id, { name: field(req, 'name'), description: field(req, 'description') });
      if (!c) return renderCase(req, res, '');
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'case.update', caseId: id, ip: req.ip });
      renderCase(req, res, id, { ok: t(req.lang, 'case.saved') });
    } catch (err) {
      renderCase(req, res, id, { error: (err as Error).message }, 400);
    }
  });

  r.post('/cases/:id/status', (req, res) => {
    const id = validId(req.params.id);
    if (!id) return renderCase(req, res, '');
    const status = field(req, 'status') === 'closed' ? 'closed' : 'open';
    const c = updateCase(ctx.db, id, { status });
    if (!c) return renderCase(req, res, '');
    // A closed case must stop serving downloads to whoever is already inside.
    if (status === 'closed') destroyAccessSessionsForCase(ctx.db, id);
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: status === 'closed' ? 'case.close' : 'case.reopen', caseId: id, ip: req.ip });
    res.redirect(303, `/admin/cases/${id}`);
  });

  // ---- notes -------------------------------------------------------------
  r.post('/cases/:id/notes', (req, res) => {
    const id = validId(req.params.id);
    if (!id) return renderCase(req, res, '');
    const c = getCase(ctx.db, id);
    if (!c) return renderCase(req, res, '');
    try {
      const note = createNote(ctx.db, { caseId: id, title: field(req, 'title'), body: field(req, 'body'), adminId: req.session!.admin.id });
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'note.create', caseId: id, itemId: note.id, ip: req.ip, details: { title: note.title } });
      renderCase(req, res, id, { ok: t(req.lang, 'items.note_added') });
    } catch {
      renderCase(req, res, id, { error: t(req.lang, 'items.note_empty') }, 400);
    }
  });

  // ---- links -------------------------------------------------------------
  r.post('/cases/:id/links', (req, res) => {
    const id = validId(req.params.id);
    if (!id) return renderCase(req, res, '');
    const c = getCase(ctx.db, id);
    if (!c) return renderCase(req, res, '');
    if (c.status !== 'open') return renderCase(req, res, id, { error: t(req.lang, 'case.closed_no_links') }, 400);
    let created;
    try {
      const expiresRaw = field(req, 'expires_at').trim();
      const expiresAt = expiresRaw ? new Date(expiresRaw.endsWith('Z') ? expiresRaw : `${expiresRaw}Z`) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error(t(req.lang, 'error.invalid_expiry'));
      const maxOpensRaw = field(req, 'max_opens').trim();
      created = createLink(ctx.db, ctx.cfg, {
        caseId: id,
        label: field(req, 'label'),
        recipientEmail: field(req, 'email'),
        expiresAt,
        maxOpens: maxOpensRaw ? Number(maxOpensRaw) : null,
        // Defaults to the language of the panel the administrator is using,
        // which the form has already pre-selected for them.
        lang: field(req, 'lang') || req.lang,
      });
    } catch (err) {
      renderCase(req, res, id, { error: (err as Error).message }, 400);
      return;
    }
    const { link, url } = created;
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.create', caseId: id, linkId: link.id, ip: req.ip, details: { label: link.label, email: link.recipient_email, expires_at: link.expires_at, max_opens: link.max_opens, lang: link.lang } });
    // The full URL is shown exactly once, in this response, and is not stored
    // anywhere. The application never mails it: handing the link over is the
    // administrator's job, and only the one-time code goes out by e-mail.
    renderCase(req, res, id, { newLink: { label: link.label, url } });
  });

  /**
   * "I need the link again" can only mean "issue a new one": the clear-text
   * token was shown once and the database keeps nothing but its hash. The
   * recipient, the limits and the opening count survive; the old URL does not.
   */
  r.post('/links/:id/reissue', (req, res) => {
    const id = validId(req.params.id);
    const link = id ? getLink(ctx.db, id) : null;
    if (!link) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    const c = getCase(ctx.db, link.case_id);
    if (!c) return sendError(req, res, 'error.not_found.title', 'error.case_missing');
    const rotated = rotateLinkToken(ctx.db, ctx.cfg, link.id);
    if (!rotated) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    // The previous URL is dead from now on, so any session opened with it goes too.
    destroyAccessSessionsForLink(ctx.db, link.id);
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.reissue', caseId: c.id, linkId: link.id, ip: req.ip });
    renderCase(req, res, c.id, { newLink: { label: link.label, url: rotated.url } });
  });

  r.post('/links/:id/revoke', (req, res) => {
    const id = validId(req.params.id);
    const link = id ? getLink(ctx.db, id) : null;
    if (!link) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    if (revokeLink(ctx.db, link.id)) {
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.revoke', caseId: link.case_id, linkId: link.id, ip: req.ip });
      // Whoever is inside right now is thrown out immediately.
      destroyAccessSessionsForLink(ctx.db, link.id);
    }
    res.redirect(303, `/admin/cases/${link.case_id}`);
  });

  // ---- items -------------------------------------------------------------
  r.get('/items/:id/download', async (req, res) => {
    const id = validId(req.params.id);
    const item = id ? getItem(ctx.db, id) : null;
    if (!item || item.kind !== 'file' || item.status !== 'ready') return sendError(req, res, 'error.not_found.title', 'error.item_missing');
    let stream;
    try {
      stream = await ctx.storage.get(item.id);
    } catch (err) {
      if (err instanceof StorageNotFoundError) return sendError(req, res, 'error.storage_missing.title', 'error.storage_missing', 410);
      throw err;
    }
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'item.download', caseId: item.case_id, itemId: item.id, ip: req.ip });
    sendAttachment(res, item.title, item.size);
    try {
      await pipeline(stream, res);
    } catch (err) {
      // Client went away mid-download; nothing to do.
      log.debug('download interrupted', { itemId: item.id, err: err as Error });
    }
  });

  r.post('/items/:id/delete', async (req, res) => {
    const id = validId(req.params.id);
    const item = id ? getItem(ctx.db, id) : null;
    if (!item) return sendError(req, res, 'error.not_found.title', 'error.item_not_exist');
    if (markDeleted(ctx.db, item.id)) {
      if (item.kind === 'file') await ctx.storage.delete(item.id);
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'item.delete', caseId: item.case_id, itemId: item.id, ip: req.ip, details: { title: item.title, size: item.size } });
    } else if (item.status === 'uploading') {
      await discardUploadData(ctx, item);
      failUpload(ctx.db, item.id, 'aborted');
    }
    res.redirect(303, `/admin/cases/${item.case_id}`);
  });

  // ---- audit -------------------------------------------------------------
  r.get('/audit', (req, res) => {
    res.type('html').send(auditPage(viewCtx(req), listAudit(ctx.db, 300)));
  });

  return r;
}

/** Always an opaque attachment: never sniffed, never rendered, never scripted. */
export function sendAttachment(res: Response, filename: string, size: number | null): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(filename, { type: 'attachment' }));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'no-store');
  if (size != null) res.setHeader('Content-Length', String(size));
}

function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}
