import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { now, transaction } from '../db.js';
import { hashPassword, newAccessCode, newCsrfToken, newId, newSessionId, normalizeCode, sha256Hex, verifyPassword } from '../crypto.js';

/**
 * The recipient side of the unlock flow:
 *   1. the visitor types an e-mail address; if it matches the link, a challenge
 *      row is created and its code e-mailed;
 *   2. the code is typed back and checked here;
 *   3. a short-lived access session is created, and the opening is counted.
 *
 * Codes are six digits, so the stored hash is scrypt (the same work factor as an
 * admin password) rather than a bare SHA-256: a leaked database must not allow
 * an instant sweep of the 10^6 space.
 */

export interface Challenge {
  id: string; link_id: string; code_hash: string; flow_hash: string; attempts: number;
  created_at: string; expires_at: string; consumed_at: string | null; ip: string | null;
}

export class ChallengeRateError extends Error {
  constructor(public readonly perHour: number) {
    super(`too many code requests (limit ${perHour}/hour for this link)`);
    this.name = 'ChallengeRateError';
  }
}

export interface AccessSession {
  linkId: string;
  csrfToken: string;
  expiresAt: string;
}

/**
 * Creates a challenge and returns the clear-text code exactly once (it is never
 * stored). Any earlier pending challenge of the same link is consumed, so only
 * the newest code ever works.
 */
export function createChallenge(db: Db, cfg: Config, input: { linkId: string; flowToken: string; ip?: string | null }): { challenge: Challenge; code: string } {
  const code = newAccessCode();
  const ts = new Date();
  const challenge: Challenge = {
    id: newId('ch'), link_id: input.linkId, code_hash: hashPassword(code), flow_hash: sha256Hex(input.flowToken),
    attempts: 0, created_at: ts.toISOString(), expires_at: new Date(ts.getTime() + cfg.accessCodeTtlMs).toISOString(),
    consumed_at: null, ip: input.ip ?? null,
  };
  transaction(db, () => {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE link_id = ? AND created_at > ?').get(input.linkId, since) as unknown as { n: number };
    if (n >= cfg.challengeLimitPerLinkPerHour) throw new ChallengeRateError(cfg.challengeLimitPerLinkPerHour);
    db.prepare('UPDATE challenges SET consumed_at = ? WHERE link_id = ? AND consumed_at IS NULL').run(challenge.created_at, input.linkId);
    db.prepare(
      `INSERT INTO challenges (id, link_id, code_hash, flow_hash, attempts, created_at, expires_at, consumed_at, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(challenge.id, challenge.link_id, challenge.code_hash, challenge.flow_hash, challenge.attempts,
      challenge.created_at, challenge.expires_at, challenge.consumed_at, challenge.ip);
  });
  return { challenge, code };
}

export type VerifyResult =
  | { status: 'ok' }
  | { status: 'invalid'; attemptsLeft: number }
  | { status: 'gone' };

/**
 * Checks a typed code against the newest pending challenge of this link *and*
 * this browser. Wrong codes are counted; once the budget is spent the challenge
 * is destroyed and the visitor has to request a new code.
 */
export function verifyChallenge(db: Db, cfg: Config, input: { linkId: string; flowToken: string; code: string }): VerifyResult {
  const flowHash = sha256Hex(input.flowToken);
  const row = db.prepare(
    `SELECT * FROM challenges WHERE link_id = ? AND flow_hash = ? AND consumed_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(input.linkId, flowHash, now()) as Challenge | undefined;
  if (!row) return { status: 'gone' };

  const code = normalizeCode(input.code);
  if (code && verifyPassword(code, row.code_hash)) {
    db.prepare('UPDATE challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now(), row.id);
    return { status: 'ok' };
  }
  const attempts = row.attempts + 1;
  if (attempts >= cfg.maxCodeAttempts) {
    db.prepare('UPDATE challenges SET attempts = ?, consumed_at = ? WHERE id = ?').run(attempts, now(), row.id);
    return { status: 'gone' };
  }
  db.prepare('UPDATE challenges SET attempts = ? WHERE id = ?').run(attempts, row.id);
  return { status: 'invalid', attemptsLeft: cfg.maxCodeAttempts - attempts };
}

export function createAccessSession(db: Db, cfg: Config, linkId: string, ip?: string | null): { sessionId: string; session: AccessSession } {
  const sessionId = newSessionId();
  const session: AccessSession = {
    linkId,
    csrfToken: newCsrfToken(),
    expiresAt: new Date(Date.now() + cfg.accessSessionTtlMs).toISOString(),
  };
  db.prepare(
    'INSERT INTO access_sessions (id_hash, link_id, csrf_token, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sha256Hex(sessionId), linkId, session.csrfToken, now(), session.expiresAt, ip ?? null);
  return { sessionId, session };
}

export function getAccessSession(db: Db, sessionId: string): AccessSession | null {
  const row = db.prepare('SELECT link_id, csrf_token, expires_at FROM access_sessions WHERE id_hash = ?')
    .get(sha256Hex(sessionId)) as { link_id: string; csrf_token: string; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at <= now()) {
    db.prepare('DELETE FROM access_sessions WHERE id_hash = ?').run(sha256Hex(sessionId));
    return null;
  }
  return { linkId: row.link_id, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

export function destroyAccessSession(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM access_sessions WHERE id_hash = ?').run(sha256Hex(sessionId));
}

/** Revoking a link (or closing a case) must also end whatever is already open. */
export function destroyAccessSessionsForLink(db: Db, linkId: string): number {
  const res = db.prepare('DELETE FROM access_sessions WHERE link_id = ?').run(linkId);
  db.prepare('UPDATE challenges SET consumed_at = ? WHERE link_id = ? AND consumed_at IS NULL').run(now(), linkId);
  return Number(res.changes);
}

export function destroyAccessSessionsForCase(db: Db, caseId: string): number {
  const res = db.prepare('DELETE FROM access_sessions WHERE link_id IN (SELECT id FROM links WHERE case_id = ?)').run(caseId);
  return Number(res.changes);
}

export function purgeExpiredAccess(db: Db): { sessions: number; challenges: number } {
  const ts = now();
  const sessions = Number(db.prepare('DELETE FROM access_sessions WHERE expires_at <= ?').run(ts).changes);
  // Consumed and expired challenges are kept for an hour so the rate limit still sees them.
  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const challenges = Number(db.prepare('DELETE FROM challenges WHERE created_at <= ?').run(cutoff).changes);
  return { sessions, challenges };
}
