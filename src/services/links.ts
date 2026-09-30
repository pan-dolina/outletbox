import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { now, transaction } from '../db.js';
import { isValidEmail, newId, newToken, normalizeEmail, sha256Hex, TOKEN_RE } from '../crypto.js';
import { isLang, type Lang } from '../i18n.js';
import { MAX_RECIPIENTS, RecipientListError, type RecipientInput } from './addresses.js';
import { getCase, type Case } from './cases.js';

export interface Link {
  id: string; case_id: string; label: string; token_hash: string; token_hint: string;
  expires_at: string | null; revoked_at: string | null;
  /** Openings of the link as a whole, whichever of its recipients opened it. */
  max_opens: number | null; opens_used: number;
  created_at: string; last_used_at: string | null;
}

/**
 * One person who may open a link. Everyone on a link shares its URL, its expiry
 * and its opening limit, but each of them unlocks it with their own address
 * and gets the code in their own language.
 */
export interface LinkRecipient {
  id: string; link_id: string; email: string; lang: Lang;
  opens: number; last_opened_at: string | null; created_at: string;
}

export type LinkState = 'active' | 'expired' | 'revoked' | 'case_closed' | 'exhausted';

export interface ResolvedLink { link: Link; case: Case; state: LinkState; recipients: LinkRecipient[] }

export interface CreateLinkInput {
  caseId: string;
  label: string;
  recipients: RecipientInput[];
  expiresAt?: Date | null;
  maxOpens?: number | null;
}

function checkRecipients(list: RecipientInput[]): RecipientInput[] {
  if (list.length === 0) throw new RecipientListError('recipients.none');
  if (list.length > MAX_RECIPIENTS) throw new RecipientListError('recipients.too_many', { max: MAX_RECIPIENTS });
  return list.map((r) => {
    const email = normalizeEmail(r.email ?? '');
    if (!isValidEmail(email)) throw new RecipientListError('recipients.invalid', { list: String(r.email).slice(0, 80) });
    return { email, lang: isLang(r.lang) ? r.lang : 'en' };
  });
}

function insertRecipients(db: Db, linkId: string, list: RecipientInput[]): LinkRecipient[] {
  const insert = db.prepare(
    `INSERT INTO link_recipients (id, link_id, email, lang, opens, last_opened_at, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT (link_id, email) DO NOTHING`,
  );
  const added: LinkRecipient[] = [];
  for (const r of list) {
    const row: LinkRecipient = { id: newId('r'), link_id: linkId, email: r.email, lang: r.lang, opens: 0, last_opened_at: null, created_at: now() };
    if (insert.run(row.id, row.link_id, row.email, row.lang, row.created_at).changes > 0) added.push(row);
  }
  return added;
}

export function createLink(db: Db, cfg: Config, input: CreateLinkInput): { link: Link; recipients: LinkRecipient[]; token: string; url: string } {
  const label = input.label.trim().slice(0, 200) || 'Recipient';
  const list = checkRecipients(input.recipients);
  if (input.maxOpens != null && (!Number.isInteger(input.maxOpens) || input.maxOpens < 1)) throw new Error('max opens must be a positive integer');
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new Error('Expiry must be in the future');
  if (!getCase(db, input.caseId)) throw new Error('Case not found');

  const token = newToken();
  const link: Link = {
    id: newId('l'), case_id: input.caseId, label,
    token_hash: sha256Hex(token), token_hint: token.slice(0, 6),
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null, revoked_at: null,
    max_opens: input.maxOpens ?? null, opens_used: 0,
    created_at: now(), last_used_at: null,
  };
  const recipients = transaction(db, () => {
    db.prepare(
      `INSERT INTO links (id, case_id, label, token_hash, token_hint, expires_at, revoked_at, max_opens, opens_used, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(link.id, link.case_id, link.label, link.token_hash, link.token_hint, link.expires_at, link.revoked_at,
      link.max_opens, link.opens_used, link.created_at, link.last_used_at);
    return insertRecipients(db, link.id, list);
  });
  // The clear-text token exists only in this return value; the database keeps its SHA-256.
  return { link, recipients, token, url: linkUrl(cfg, token) };
}

/** Adds people to an existing link. Addresses already on it are skipped, not duplicated. */
export function addRecipients(db: Db, linkId: string, input: RecipientInput[]): LinkRecipient[] {
  const list = checkRecipients(input);
  return transaction(db, () => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM link_recipients WHERE link_id = ?').get(linkId) as unknown as { n: number };
    const fresh = list.filter((r) => !db.prepare('SELECT 1 FROM link_recipients WHERE link_id = ? AND email = ?').get(linkId, r.email));
    if (n + fresh.length > MAX_RECIPIENTS) throw new RecipientListError('recipients.too_many', { max: MAX_RECIPIENTS });
    return insertRecipients(db, linkId, fresh);
  });
}

/**
 * Takes one person off a link. Their pending codes and open sessions go with
 * the row (ON DELETE CASCADE). The last person cannot be removed: a link nobody
 * can open is a revoked link, and revoking says so in the panel and the audit log.
 */
export function removeRecipient(db: Db, linkId: string, recipientId: string): LinkRecipient | 'last' | null {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM link_recipients WHERE id = ? AND link_id = ?').get(recipientId, linkId) as LinkRecipient | undefined;
    if (!row) return null;
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM link_recipients WHERE link_id = ?').get(linkId) as unknown as { n: number };
    if (n <= 1) return 'last';
    db.prepare('DELETE FROM link_recipients WHERE id = ?').run(recipientId);
    return row;
  });
}

export function listRecipients(db: Db, linkId: string): LinkRecipient[] {
  return db.prepare('SELECT * FROM link_recipients WHERE link_id = ? ORDER BY rowid').all(linkId) as unknown as LinkRecipient[];
}

/** Every recipient of every link of a case, grouped by link id — one query for the panel. */
export function recipientsForCase(db: Db, caseId: string): Map<string, LinkRecipient[]> {
  const rows = db.prepare(
    `SELECT r.* FROM link_recipients r JOIN links l ON l.id = r.link_id WHERE l.case_id = ? ORDER BY r.rowid`,
  ).all(caseId) as unknown as LinkRecipient[];
  const out = new Map<string, LinkRecipient[]>();
  for (const r of rows) out.set(r.link_id, [...(out.get(r.link_id) ?? []), r]);
  return out;
}

/**
 * The language the pages of a link speak before anyone has proved who they
 * are: the recipients' language when they all share one, otherwise nothing
 * (and the browser decides). It must not depend on the address a visitor
 * typed — that would tell them whether the address was on the list.
 */
export function sharedLang(recipients: readonly LinkRecipient[]): Lang | null {
  const first = recipients[0]?.lang;
  return first && recipients.every((r) => r.lang === first) ? first : null;
}

/** Counts one opening against a person; informational, the limit lives on the link. */
export function recordRecipientOpen(db: Db, recipientId: string): void {
  db.prepare('UPDATE link_recipients SET opens = opens + 1, last_opened_at = ? WHERE id = ?').run(now(), recipientId);
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
  return { link, case: c, state: linkState(link, c), recipients: listRecipients(db, link.id) };
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
 * Issues a fresh token for an existing link, keeping the recipients, the limits
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

/** The person whose address was typed, or null when it is not on this link. */
export function findRecipient(recipients: readonly LinkRecipient[], typed: string): LinkRecipient | null {
  const email = normalizeEmail(typed);
  return recipients.find((r) => r.email === email) ?? null;
}

export function openingsLeft(link: Link): number | null {
  return link.max_opens == null ? null : Math.max(link.max_opens - link.opens_used, 0);
}
