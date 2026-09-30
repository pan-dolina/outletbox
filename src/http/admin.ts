import { Router, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { create as contentDisposition } from 'content-disposition';
import QRCode from 'qrcode';
import { pipeline } from 'node:stream/promises';
import { ID_RE } from '../crypto.js';
import { log } from '../log.js';
import { audit, listAudit } from '../services/audit.js';
import {
  authenticate, beginTotpEnrolment, changeAdminPassword, confirmTotpEnrolment, createSession, destroyOtherSessions, destroySession,
  disableTotp, MAX_TOTP_ATTEMPTS, pendingTotpSecret, recordLogin, regenerateRecoveryCodes, remainingRecoveryCodes, totpLockedUntil, verifySessionTotp,
} from '../services/auth.js';
import {
  addCaseMember, assignableUsers, canAccessCase, caseMembers, createUser, deleteUser, getUser, isRole, listUsers, removeCaseMember,
  resetUserPassword, resetUserTotp, setUserDisabled, setUserRole, UserError, type UserSummary,
} from '../services/users.js';
import { destroyAccessSessionsForCase, destroyAccessSessionsForLink } from '../services/access.js';
import { createCase, getCase, listCases, updateCase, type Case } from '../services/cases.js';
import { discardUploadData } from '../services/cleanup.js';
import {
  completeUpload, createNote, failUpload, getItem, listItemsForCase, LimitError, markDeleted, sanitizeFilename, startUpload,
} from '../services/items.js';
import { requireRecipients, RecipientListError } from '../services/addresses.js';
import { createGroup, deleteGroup, getGroup, groupMembers, listGroups, updateGroup } from '../services/groups.js';
import {
  addRecipients, createLink, getLink, listLinksForCase, recipientsForCase, removeRecipient, revokeLink, rotateLinkToken,
} from '../services/links.js';
import { StorageLimitError, StorageNotFoundError } from '../storage/index.js';
import { otpauthUri } from '../totp.js';
import { isLang, t, type Lang, type MessageKey } from '../i18n.js';
import type { AppContext } from './context.js';
import { SESSION_COOKIE } from './context.js';
import { clearCookie, csrfProtect, loginLimiter, requireAdmin, sessionCookie } from './middleware.js';
import { createTusServer, tusHandler } from './tus.js';
import { adminNav, auditPage, casePage, casesPage, errorPage, usersPage, type UsersPageData, groupsPage, loginPage, type AdminViewContext } from './views/admin.js';
import { securityPage, totpLoginPage, type SecurityPageData } from './views/security.js';

function viewCtx(req: Request): AdminViewContext {
  const { admin } = req.session!;
  return { lang: req.lang, csrfToken: req.session!.csrfToken, username: admin.username, path: req.originalUrl, role: admin.role, userId: admin.id };
}

function sendError(req: Request, res: Response, titleKey: MessageKey, messageKey: MessageKey, status = 404): void {
  const e = errorPage(req.lang, t(req.lang, titleKey), t(req.lang, messageKey), status, req.originalUrl, '/admin');
  res.status(e.status).type('html').send(e.body);
}

function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

/** A route parameter as a string; Express types it loosely once middleware sits in front of the handler. */
function param(req: Request, name: string): string | undefined {
  const v = req.params[name];
  return typeof v === 'string' ? v : undefined;
}

function validId(id: string | undefined): string | null {
  return id && ID_RE.test(id) ? id : null;
}

/** A service error in the admin's language when it carries a message key, as-is otherwise. */
function errorText(req: Request, err: unknown): string {
  return err instanceof RecipientListError ? t(req.lang, err.key, err.params) : (err as Error).message;
}

/** The language picked in the form for addresses that do not name one; the panel's own by default. */
function formLang(req: Request): Lang {
  const v = field(req, 'lang');
  return isLang(v) ? v : req.lang;
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
    recordLogin(ctx.db, admin.id);
    audit(ctx.db, { actorType: 'admin', actorId: admin.id, action: 'admin.login', ip: req.ip });
    res.redirect(303, (ctx.cfg.adminRequireTotp || admin.must_change_password) ? '/admin/security' : '/admin');
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
      recordLogin(ctx.db, session.admin.id);
      audit(ctx.db, { actorType: 'admin', actorId: session.admin.id, action: 'admin.login', ip: req.ip, details: { second_factor: true } });
      // Fresh session id for the privileged session.
      res.setHeader('Set-Cookie', sessionCookie(ctx, result.sessionId, Math.floor(ctx.cfg.sessionTtlMs / 1000)));
      res.redirect(303, session.admin.must_change_password ? '/admin/security' : '/admin');
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
      mustChangePassword: session.admin.must_change_password,
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
    session.admin.must_change_password = false;
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

  // With ADMIN_REQUIRE_TOTP, accounts without a second factor may only reach the
  // security page; so may an account still holding a password an administrator issued.
  r.use((req, res, next) => {
    const { admin } = req.session!;
    const missing = admin.must_change_password ? 'Password change required' : ctx.cfg.adminRequireTotp && !admin.totp_enabled ? 'TOTP enrolment required' : null;
    if (missing) {
      if (req.method === 'GET') return res.redirect(302, '/admin/security');
      res.status(403).type('text/plain').send(missing);
      return;
    }
    next();
  });

  /**
   * The case, if this account may work on it. A case someone is not assigned to
   * answers exactly like one that does not exist: its id reveals nothing.
   */
  function caseFor(req: Request, id: string | null | undefined): Case | null {
    const c = id ? getCase(ctx.db, id) : null;
    return c && canAccessCase(ctx.db, req.session!.admin, c.id) ? c : null;
  }

  /** Accounts, assignments and the audit log are the administrators' alone. */
  const adminsOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (req.session!.admin.role === 'admin') return next();
    sendError(req, res, 'error.forbidden.title', 'error.forbidden', 403);
  };

  // ---- uploads (browser: tus; scripts: a plain streaming PUT) --------------
  r.all('/api/tus', tusHandler(tus));
  r.all('/api/tus/:id', tusHandler(tus));

  r.put('/api/cases/:caseId/upload/:name', (req, res, next) => { directUpload(req, res).catch(next); });
  r.post('/api/cases/:caseId/upload/:name', (req, res, next) => { directUpload(req, res).catch(next); });

  async function directUpload(req: Request, res: Response): Promise<void> {
    const caseId = validId(typeof req.params.caseId === 'string' ? req.params.caseId : undefined);
    const c = caseFor(req, caseId);
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
    res.type('html').send(casesPage(viewCtx(req), listCases(ctx.db, req.session!.admin)));
  });

  r.post('/cases', (req, res) => {
    try {
      const c = createCase(ctx.db, { name: field(req, 'name'), description: field(req, 'description') });
      // A user who opens a case works on it; an administrator sees it anyway.
      if (req.session!.admin.role !== 'admin') addCaseMember(ctx.db, c.id, req.session!.admin.id);
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'case.create', caseId: c.id, ip: req.ip, details: { name: c.name } });
      res.redirect(303, `/admin/cases/${c.id}`);
    } catch (err) {
      res.status(400).type('html').send(casesPage(viewCtx(req), listCases(ctx.db, req.session!.admin), { error: (err as Error).message }));
    }
  });

  function renderCase(req: Request, res: Response, caseId: string, extra: { error?: string; ok?: string; newLink?: { label: string; url: string } } = {}, status = 200): void {
    const c = caseFor(req, caseId);
    if (!c) return sendError(req, res, 'error.not_found.title', 'error.case_missing');
    res.status(status).type('html').send(casePage(viewCtx(req), {
      case: c, links: listLinksForCase(ctx.db, c.id), recipients: recipientsForCase(ctx.db, c.id), groups: listGroups(ctx.db),
      items: listItemsForCase(ctx.db, c.id), cfg: ctx.cfg,
      members: caseMembers(ctx.db, c.id), assignable: req.session!.admin.role === 'admin' ? assignableUsers(ctx.db, c.id) : [], ...extra,
    }));
  }

  /**
   * The addresses a form asked for: the typed list plus, when one was chosen,
   * a group's members. The panel's script copies a chosen group into the text
   * area and clears the choice, so the admin sees exactly who is being added;
   * without JavaScript the server does the same merge here.
   */
  function recipientsFromForm(req: Request) {
    return requireRecipients(field(req, 'recipients'), formLang(req), groupMembers(ctx.db, validId(field(req, 'group'))));
  }

  r.get('/cases/:id', (req, res) => {
    const id = validId(param(req, 'id'));
    if (!id) return renderCase(req, res, '');
    renderCase(req, res, id);
  });

  r.post('/cases/:id', (req, res) => {
    const id = validId(param(req, 'id'));
    if (!id) return renderCase(req, res, '');
    if (!caseFor(req, id)) return renderCase(req, res, '');
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
    const id = validId(param(req, 'id'));
    if (!id) return renderCase(req, res, '');
    if (!caseFor(req, id)) return renderCase(req, res, '');
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
    const id = validId(param(req, 'id'));
    if (!id) return renderCase(req, res, '');
    const c = caseFor(req, id);
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
    const id = validId(param(req, 'id'));
    if (!id) return renderCase(req, res, '');
    const c = caseFor(req, id);
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
        recipients: recipientsFromForm(req),
        expiresAt,
        maxOpens: maxOpensRaw ? Number(maxOpensRaw) : null,
      });
    } catch (err) {
      renderCase(req, res, id, { error: errorText(req, err) }, 400);
      return;
    }
    const { link, recipients, url } = created;
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.create', caseId: id, linkId: link.id, ip: req.ip, details: {
      label: link.label, recipients: recipients.map((r) => `${r.email} ${r.lang}`), expires_at: link.expires_at, max_opens: link.max_opens,
    } });
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
    const id = validId(param(req, 'id'));
    const link = id ? getLink(ctx.db, id) : null;
    if (!link || !caseFor(req, link.case_id)) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    const c = getCase(ctx.db, link.case_id);
    if (!c) return sendError(req, res, 'error.not_found.title', 'error.case_missing');
    const rotated = rotateLinkToken(ctx.db, ctx.cfg, link.id);
    if (!rotated) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    // The previous URL is dead from now on, so any session opened with it goes too.
    destroyAccessSessionsForLink(ctx.db, link.id);
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.reissue', caseId: c.id, linkId: link.id, ip: req.ip });
    renderCase(req, res, c.id, { newLink: { label: link.label, url: rotated.url } });
  });

  r.post('/links/:id/recipients', (req, res) => {
    const id = validId(param(req, 'id'));
    const link = id ? getLink(ctx.db, id) : null;
    if (!link || !caseFor(req, link.case_id)) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    if (link.revoked_at) return renderCase(req, res, link.case_id, { error: t(req.lang, 'links.revoked_no_changes') }, 400);
    let added;
    try {
      added = addRecipients(ctx.db, link.id, recipientsFromForm(req));
    } catch (err) {
      renderCase(req, res, link.case_id, { error: errorText(req, err) }, 400);
      return;
    }
    if (added.length) {
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.recipients_add', caseId: link.case_id, linkId: link.id, ip: req.ip, details: { recipients: added.map((r) => `${r.email} ${r.lang}`) } });
    }
    // The URL does not change: whoever already has it can pass it on to the new people.
    renderCase(req, res, link.case_id, { ok: t(req.lang, 'links.recipients_added', { n: added.length, label: link.label }) });
  });

  r.post('/links/:id/recipients/:rid/remove', (req, res) => {
    const id = validId(param(req, 'id'));
    const link = id ? getLink(ctx.db, id) : null;
    if (!link || !caseFor(req, link.case_id)) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    const rid = validId(req.params.rid);
    const removed = rid ? removeRecipient(ctx.db, link.id, rid) : null;
    if (removed === 'last') return renderCase(req, res, link.case_id, { error: t(req.lang, 'links.last_recipient') }, 400);
    if (!removed) return renderCase(req, res, link.case_id, { error: t(req.lang, 'error.recipient_missing') }, 404);
    // Their pending code and any open session went with the row.
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.recipient_remove', caseId: link.case_id, linkId: link.id, ip: req.ip, details: { email: removed.email } });
    renderCase(req, res, link.case_id, { ok: t(req.lang, 'links.recipient_removed', { email: removed.email, label: link.label }) });
  });

  r.post('/links/:id/revoke', (req, res) => {
    const id = validId(param(req, 'id'));
    const link = id ? getLink(ctx.db, id) : null;
    if (!link || !caseFor(req, link.case_id)) return sendError(req, res, 'error.not_found.title', 'error.link_missing');
    if (revokeLink(ctx.db, link.id)) {
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'link.revoke', caseId: link.case_id, linkId: link.id, ip: req.ip });
      // Whoever is inside right now is thrown out immediately.
      destroyAccessSessionsForLink(ctx.db, link.id);
    }
    res.redirect(303, `/admin/cases/${link.case_id}`);
  });

  // ---- items -------------------------------------------------------------
  r.get('/items/:id/download', async (req, res) => {
    const id = validId(param(req, 'id'));
    const item = id ? getItem(ctx.db, id) : null;
    if (!item || item.kind !== 'file' || item.status !== 'ready' || !caseFor(req, item.case_id)) return sendError(req, res, 'error.not_found.title', 'error.item_missing');
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
    const id = validId(param(req, 'id'));
    const item = id ? getItem(ctx.db, id) : null;
    if (!item || !caseFor(req, item.case_id)) return sendError(req, res, 'error.not_found.title', 'error.item_not_exist');
    if (markDeleted(ctx.db, item.id)) {
      if (item.kind === 'file') await ctx.storage.delete(item.id);
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'item.delete', caseId: item.case_id, itemId: item.id, ip: req.ip, details: { title: item.title, size: item.size } });
    } else if (item.status === 'uploading') {
      await discardUploadData(ctx, item);
      failUpload(ctx.db, item.id, 'aborted');
    }
    res.redirect(303, `/admin/cases/${item.case_id}`);
  });

  // ---- address groups ----------------------------------------------------
  function renderGroups(req: Request, res: Response, extra: { error?: string; ok?: string; draft?: { id: string | null; name: string; members: string } } = {}, status = 200): void {
    res.status(status).type('html').send(groupsPage(viewCtx(req), listGroups(ctx.db), extra));
  }

  /** What the group form was trying to save, so an error does not throw the typing away. */
  const groupDraft = (req: Request, id: string | null) => ({ id, name: field(req, 'name'), members: field(req, 'recipients') });

  // Address groups are shared by everyone who issues links; administrators keep them.
  r.get('/groups', adminsOnly, (req, res) => renderGroups(req, res));

  r.post('/groups', adminsOnly, (req, res) => {
    try {
      const g = createGroup(ctx.db, { name: field(req, 'name'), members: requireRecipients(field(req, 'recipients'), formLang(req)) });
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'group.create', ip: req.ip, details: { group: g.id, name: g.name, members: g.members.length } });
      renderGroups(req, res, { ok: t(req.lang, 'groups.created', { name: g.name }) });
    } catch (err) {
      renderGroups(req, res, { error: errorText(req, err), draft: groupDraft(req, null) }, 400);
    }
  });

  r.post('/groups/:id', adminsOnly, (req, res) => {
    const id = validId(param(req, 'id'));
    if (!id || !getGroup(ctx.db, id)) return renderGroups(req, res, { error: t(req.lang, 'groups.missing') }, 404);
    try {
      const g = updateGroup(ctx.db, id, { name: field(req, 'name'), members: requireRecipients(field(req, 'recipients'), formLang(req)) })!;
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'group.update', ip: req.ip, details: { group: g.id, name: g.name, members: g.members.length } });
      renderGroups(req, res, { ok: t(req.lang, 'groups.saved', { name: g.name }) });
    } catch (err) {
      renderGroups(req, res, { error: errorText(req, err), draft: groupDraft(req, id) }, 400);
    }
  });

  r.post('/groups/:id/delete', adminsOnly, (req, res) => {
    const id = validId(param(req, 'id'));
    const g = id ? getGroup(ctx.db, id) : null;
    if (!g) return renderGroups(req, res, { error: t(req.lang, 'groups.missing') }, 404);
    deleteGroup(ctx.db, g.id);
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'group.delete', ip: req.ip, details: { group: g.id, name: g.name } });
    renderGroups(req, res, { ok: t(req.lang, 'groups.deleted', { name: g.name }) });
  });

  // ---- case assignments ---------------------------------------------------
  r.post('/cases/:id/members', adminsOnly, (req, res) => {
    const id = validId(param(req, 'id'));
    const c = caseFor(req, id);
    if (!c) return renderCase(req, res, '');
    const user = getUser(ctx.db, validId(field(req, 'user_id')) ?? '');
    if (!user || user.role !== 'user' || user.disabled_at) return renderCase(req, res, c.id, { error: t(req.lang, 'users.missing') }, 400);
    if (addCaseMember(ctx.db, c.id, user.id)) {
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'case.member_add', caseId: c.id, ip: req.ip, details: { user: user.id, username: user.username } });
    }
    renderCase(req, res, c.id, { ok: t(req.lang, 'members.added', { username: user.username }) });
  });

  r.post('/cases/:id/members/:uid/remove', adminsOnly, (req, res) => {
    const id = validId(param(req, 'id'));
    const c = caseFor(req, id);
    if (!c) return renderCase(req, res, '');
    const user = getUser(ctx.db, validId(param(req, 'uid')) ?? '');
    if (!user || !removeCaseMember(ctx.db, c.id, user.id)) return renderCase(req, res, c.id, { error: t(req.lang, 'users.missing') }, 404);
    audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'case.member_remove', caseId: c.id, ip: req.ip, details: { user: user.id, username: user.username } });
    renderCase(req, res, c.id, { ok: t(req.lang, 'members.removed', { username: user.username }) });
  });

  // ---- accounts ------------------------------------------------------------
  function renderUsers(req: Request, res: Response, extra: Omit<UsersPageData, 'users'> = {}, status = 200): void {
    res.status(status).type('html').send(usersPage(viewCtx(req), { users: listUsers(ctx.db), ...extra }));
  }

  function userErrorText(req: Request, err: unknown): string {
    if (err instanceof UserError) return t(req.lang, err.key, err.params);
    throw err;
  }

  r.get('/users', adminsOnly, (req, res) => renderUsers(req, res));

  r.post('/users', adminsOnly, (req, res) => {
    const role = field(req, 'role');
    try {
      const { user, password } = createUser(ctx.db, { username: field(req, 'username'), role: isRole(role) ? role : 'user' });
      audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action: 'user.create', ip: req.ip, details: { user: user.id, username: user.username, role: user.role } });
      // The password is shown once, in this response, and never stored in clear.
      renderUsers(req, res, { issued: { username: user.username, password, reset: false } });
    } catch (err) {
      renderUsers(req, res, { error: userErrorText(req, err) }, 400);
    }
  });

  /** One account action: runs `fn`, audits it, and redraws the list with the outcome. */
  function userAction(path: string, action: string, fn: (req: Request, actorId: string, id: string) => { user: UserSummary; ok: string; details?: Record<string, unknown>; issued?: UsersPageData['issued'] }) {
    r.post(`/users/:id/${path}`, adminsOnly, (req, res) => {
      const id = validId(param(req, 'id'));
      if (!id) return renderUsers(req, res, { error: t(req.lang, 'users.missing') }, 404);
      try {
        const done = fn(req, req.session!.admin.id, id);
        audit(ctx.db, { actorType: 'admin', actorId: req.session!.admin.id, action, ip: req.ip, details: { user: done.user.id, username: done.user.username, ...done.details } });
        renderUsers(req, res, { ok: done.ok, issued: done.issued });
      } catch (err) {
        renderUsers(req, res, { error: userErrorText(req, err) }, 400);
      }
    });
  }

  userAction('role', 'user.role', (req, actor, id) => {
    const role = field(req, 'role');
    if (!isRole(role)) throw new UserError('users.invalid_role');
    const user = setUserRole(ctx.db, actor, id, role);
    return { user, ok: t(req.lang, 'users.role_changed', { username: user.username, role: t(req.lang, role === 'admin' ? 'users.role.admin' : 'users.role.user') }), details: { role } };
  });
  userAction('password', 'user.password_reset', (req, actor, id) => {
    const { user, password } = resetUserPassword(ctx.db, actor, id);
    return { user, ok: t(req.lang, 'users.password_reset', { username: user.username }), issued: { username: user.username, password, reset: true } };
  });
  userAction('totp', 'user.totp_reset', (req, actor, id) => {
    const user = resetUserTotp(ctx.db, actor, id);
    return { user, ok: t(req.lang, 'users.totp_reset', { username: user.username }) };
  });
  userAction('disable', 'user.disable', (req, actor, id) => {
    const user = setUserDisabled(ctx.db, actor, id, true);
    return { user, ok: t(req.lang, 'users.disabled', { username: user.username }) };
  });
  userAction('enable', 'user.enable', (req, actor, id) => {
    const user = setUserDisabled(ctx.db, actor, id, false);
    return { user, ok: t(req.lang, 'users.enabled', { username: user.username }) };
  });
  userAction('delete', 'user.delete', (req, actor, id) => {
    const user = deleteUser(ctx.db, actor, id);
    return { user, ok: t(req.lang, 'users.deleted', { username: user.username }) };
  });

  // ---- audit -------------------------------------------------------------
  r.get('/audit', adminsOnly, (req, res) => {
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
