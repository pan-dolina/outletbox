import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { newFlowToken, safeEqual } from '../crypto.js';
import { isLang, LANG_COOKIE, negotiateLang, t, type MessageKey } from '../i18n.js';
import { log, redact } from '../log.js';
import { getAccessSession } from '../services/access.js';
import { getSession } from '../services/auth.js';
import type { LinkState } from '../services/links.js';
import { ACCESS_COOKIE, FLOW_COOKIE, SESSION_COOKIE, type AppContext } from './context.js';

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'object-src': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    strictTransportSecurity: false, // HSTS belongs to the TLS-terminating reverse proxy
  });
}

// ---------------------------------------------------------------------------
// Request logging (never logs headers, bodies, query strings or link tokens)
// ---------------------------------------------------------------------------

export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    const ip = req.ip; // resolve now: the socket may be gone by the time the response finishes
    const method = req.method;
    const path = redact(req.path);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.info('request', { method, path, status: res.statusCode, ms: Math.round(ms), ip });
    });
    next();
  };
}

// ---------------------------------------------------------------------------
// Language: explicit cookie (set by the footer switcher) beats Accept-Language; English is the default.
// ---------------------------------------------------------------------------

export function languageMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const fromCookie = parseCookies(req.headers.cookie)[LANG_COOKIE];
    req.lang = isLang(fromCookie) ? fromCookie : negotiateLang(req.headers['accept-language']);
    next();
  };
}

export function langCookie(ctx: AppContext, lang: string): string {
  const parts = [`${LANG_COOKIE}=${lang}`, 'Path=/', 'SameSite=Lax', `Max-Age=${365 * 24 * 3600}`];
  if (ctx.cfg.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { /* malformed cookie value: ignore it */ }
  }
  return out;
}

function cookie(ctx: AppContext, name: string, value: string, maxAgeSec: number): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (ctx.cfg.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionCookie(ctx: AppContext, value: string, maxAgeSec: number): string {
  return cookie(ctx, SESSION_COOKIE, value, maxAgeSec);
}

export function accessCookie(ctx: AppContext, value: string, maxAgeSec: number): string {
  return cookie(ctx, ACCESS_COOKIE, value, maxAgeSec);
}

export function flowCookie(ctx: AppContext, value: string): string {
  return cookie(ctx, FLOW_COOKIE, value, 3600);
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Admin sessions
// ---------------------------------------------------------------------------

export function sessionMiddleware(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) {
      const session = getSession(ctx.db, sid);
      if (session) {
        req.session = session;
        req.sessionId = sid;
      }
    }
    next();
  };
}

/** A session must exist. With `verified: true` the second factor must also have been passed. */
export function requireAdmin(opts: { verified: boolean } = { verified: true }): RequestHandler {
  return (req, res, next) => {
    if (req.session && (!opts.verified || req.session.totpVerified)) return next();
    const target = req.session ? '/admin/totp' : '/admin/login';
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.redirect(302, target);
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.status(401).type('text/plain').send('Unauthorized');
  };
}

/**
 * CSRF protection for cookie-authenticated routes:
 *  - SameSite=Lax cookies already block cross-site POSTs in modern browsers;
 *  - additionally, Sec-Fetch-Site (when present) must be same-origin/none and a
 *    concrete Origin must match this site. Note that with Referrer-Policy:
 *    no-referrer browsers send "Origin: null" on same-origin form posts, so a
 *    null Origin is treated as unknown rather than foreign;
 *  - and every form carries a per-session synchroniser token, which is the
 *    check that actually decides. Uploads (tus, fetch) send the same token in
 *    the X-CSRF-Token header instead, because they have no form body.
 */
export function csrfProtect(ctx: AppContext): RequestHandler {
  const expectedOrigin = new URL(ctx.cfg.publicUrl).origin;
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!checkOrigin(req.headers, expectedOrigin, `${req.protocol}://${req.headers.host}`)) {
      log.warn('csrf: request rejected', { reason: 'origin', origin: req.headers.origin, fetchSite: req.headers['sec-fetch-site'], path: req.path });
      res.status(403).type('text/plain').send(t(req.lang, 'error.cross_site'));
      return;
    }
    const header = req.headers['x-csrf-token'];
    const token = typeof header === 'string' && header ? header : (req.body as Record<string, unknown> | undefined)?._csrf;
    if (!req.session || typeof token !== 'string' || !safeEqual(token, req.session.csrfToken)) {
      res.status(403).type('text/plain').send(t(req.lang, 'error.csrf'));
      return;
    }
    next();
  };
}

function checkOrigin(headers: Record<string, unknown>, expectedOrigin: string, hostOrigin: string): boolean {
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'none'].includes(String(fetchSite))) return false;
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== 'null' && origin !== expectedOrigin && origin !== hostOrigin) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Recipient flow: per-browser token and access session
// ---------------------------------------------------------------------------

/**
 * Gives every visitor of a delivery page a random flow token. It is a
 * double-submit CSRF token for the unauthenticated forms *and* the value a
 * challenge is bound to, so a code mailed to one browser cannot be typed into
 * another.
 */
export function flowMiddleware(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    const existing = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    if (existing) {
      req.flowToken = existing;
    } else {
      const token = newFlowToken();
      req.flowToken = token;
      res.append('Set-Cookie', flowCookie(ctx, token));
    }
    next();
  };
}

/** Same checks as the admin CSRF guard, but the shared secret is the flow cookie. */
export function publicFormGuard(ctx: AppContext): RequestHandler {
  const expectedOrigin = new URL(ctx.cfg.publicUrl).origin;
  return (req, res, next) => {
    if (!checkOrigin(req.headers, expectedOrigin, `${req.protocol}://${req.headers.host}`)) {
      res.status(403).type('text/plain').send(t(req.lang, 'error.cross_site'));
      return;
    }
    const sent = (req.body as Record<string, unknown> | undefined)?._flow;
    const cookieValue = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    if (!cookieValue || typeof sent !== 'string' || !safeEqual(sent, cookieValue)) {
      res.status(403).type('text/plain').send(t(req.lang, 'error.csrf'));
      return;
    }
    next();
  };
}

export function accessMiddleware(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const id = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
    if (id) {
      const session = getAccessSession(ctx.db, id);
      if (session) {
        req.access = session;
        req.accessId = id;
      }
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export function loginLimiter(ctx: AppContext): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: ctx.cfg.loginRateLimitPer15Min,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: 'Too many login attempts. Try again later.',
  });
}

/** Counts only failed (401/403/404) token lookups, so brute-forcing link tokens is throttled. */
export function tokenFailureLimiter(ctx: AppContext): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: ctx.cfg.tokenFailureRateLimitPer15Min,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401 && res.statusCode !== 404,
    message: 'Too many failed attempts. Try again later.',
  });
}

/**
 * Wrong e-mail addresses and wrong codes both land here: this is the budget
 * that stops someone guessing the address a link belongs to, or a six-digit
 * code, from one IP.
 */
export function unlockLimiter(ctx: AppContext): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: Math.max(ctx.cfg.tokenFailureRateLimitPer15Min, 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: 'Too many attempts. Try again later.',
  });
}

export function publicLimiter(ctx: AppContext): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: ctx.cfg.publicRateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: 'Too many requests. Slow down.',
  });
}

export const LINK_STATE_MESSAGES: Record<Exclude<LinkState, 'active'>, { status: number; code: string; message: MessageKey }> = {
  expired: { status: 403, code: 'link_expired', message: 'link.expired' },
  revoked: { status: 403, code: 'link_revoked', message: 'link.revoked' },
  case_closed: { status: 403, code: 'case_closed', message: 'link.case_closed' },
  exhausted: { status: 403, code: 'link_exhausted', message: 'link.exhausted' },
};
