import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { now } from '../db.js';
import { isValidEmail, newId, newToken, normalizeEmail, sha256Hex, TOKEN_RE } from '../crypto.js';
import { getCase, type Case } from './cases.js';

export interface Link {
  id: string; case_id: string; label: string; recipient_email: string; token_hash: string; token_hint: string;
  expires_at: string | null; revoked_at: string | null;
  max_opens: number | null; opens_used: number;
  created_at: string; last_used_at: string | null;
}

export type LinkState = 'active' | 'expired' | 'revoked' | 'case_closed' | 'exhausted';

export interface ResolvedLink { link: Link; case: Case; state: LinkState }

export interface CreateLinkInput {
  caseId: string;
  label: string;
  recipientEmail: string;
  expiresAt?: Date | null;
  maxOpens?: number | null;
}

export function createLink(db: Db, cfg: Config, input: CreateLinkInput): { link: Link; token: string; url: string } {
  const label = input.label.trim().slice(0, 200) || 'Recipient';
  const email = normalizeEmail(input.recipientEmail ?? '');
  if (!isValidEmail(email)) throw new Error('A valid recipient e-mail address is required');
  if (input.maxOpens != null && (!Number.isInteger(input.maxOpens) || input.maxOpens < 1)) throw new Error('max opens must be a positive integer');
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new Error('Expiry must be in the future');
  if (!getCase(db, input.caseId)) throw new Error('Case not found');

  const token = newToken();
  const link: Link = {
    id: newId('l'), case_id: input.caseId, label, recipient_email: email,
    token_hash: sha256Hex(token), token_hint: token.slice(0, 6),
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null, revoked_at: null,
    max_opens: input.maxOpens ?? null, opens_used: 0,
    created_at: now(), last_used_at: null,
  };
  db.prepare(
    `INSERT INTO links (id, case_id, label, recipient_email, token_hash, token_hint, expires_at, revoked_at, max_opens, opens_used, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(link.id, link.case_id, link.label, link.recipient_email, link.token_hash, link.token_hint, link.expires_at, link.revoked_at,
    link.max_opens, link.opens_used, link.created_at, link.last_used_at);
  // The clear-text token exists only in this return value; the database keeps its SHA-256.
  return { link, token, url: linkUrl(cfg, token) };
}

export function linkUrl(cfg: Config, token: string): string {
  return `${cfg.publicUrl}/d/${token}`;
}

export function getLink(db: Db, id: string): Link | null {
  return (db.prepare('SELECT * FROM links WHERE id = ?').get(id) as Link | undefined) ?? null;
}

export function listLinksForCase(db: Db, caseId: string): Link[] {
  return db.prepare('SELECT * FROM links WHERE case_id = ? ORDER BY created_at DESC').all(caseId) as unknown as Link[];
}

export function revokeLink(db: Db, id: string): boolean {
  const res = db.prepare('UPDATE links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
  return res.changes > 0;
}

export function linkState(link: Link, c: Case): LinkState {
  if (link.revoked_at) return 'revoked';
  if (link.expires_at && link.expires_at <= now()) return 'expired';
  if (c.status !== 'open') return 'case_closed';
  if (link.max_opens != null && link.opens_used >= link.max_opens) return 'exhausted';
  return 'active';
}

/** Looks a link up by its clear-text token. Returns null for unknown tokens. */
export function resolveToken(db: Db, token: string): ResolvedLink | null {
  if (!TOKEN_RE.test(token)) return null;
  const link = db.prepare('SELECT * FROM links WHERE token_hash = ?').get(sha256Hex(token)) as Link | undefined;
  if (!link) return null;
  const c = getCase(db, link.case_id);
  if (!c) return null;
  return { link, case: c, state: linkState(link, c) };
}

export function touchLink(db: Db, id: string): void {
  db.prepare('UPDATE links SET last_used_at = ? WHERE id = ?').run(now(), id);
}

/**
 * Counts one opening. Runs as a conditional UPDATE so two codes redeemed at the
 * same moment can never push `opens_used` past `max_opens`.
 */
export function registerOpen(db: Db, id: string): boolean {
  const res = db.prepare(
    `UPDATE links SET opens_used = opens_used + 1, last_used_at = ?
     WHERE id = ? AND revoked_at IS NULL AND (max_opens IS NULL OR opens_used < max_opens)`,
  ).run(now(), id);
  return res.changes > 0;
}

/**
 * Issues a fresh token for an existing link, keeping the recipient, the limits
 * and the opening count. The clear-text token is shown exactly once, so
 * "I need the link again" can only mean "issue a new one" — the old URL stops
 * working the moment this returns.
 */
export function rotateLinkToken(db: Db, cfg: Config, id: string): { token: string; url: string } | null {
  const link = getLink(db, id);
  if (!link) return null;
  const token = newToken();
  db.prepare('UPDATE links SET token_hash = ?, token_hint = ? WHERE id = ?').run(sha256Hex(token), token.slice(0, 6), id);
  return { token, url: linkUrl(cfg, token) };
}

/** True when the address the recipient typed is the one this link was issued for. */
export function emailMatches(link: Link, typed: string): boolean {
  return normalizeEmail(typed) === link.recipient_email;
}

export function openingsLeft(link: Link): number | null {
  return link.max_opens == null ? null : Math.max(link.max_opens - link.opens_used, 0);
}
