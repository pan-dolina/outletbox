import type { MailDriverKind } from '../config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  /** Plain text body. Always present: it is what most recipients' clients show. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
}

export class MailError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MailError';
  }
}

export interface Mailer {
  readonly kind: MailDriverKind;
  send(msg: OutgoingMail): Promise<void>;
  /** Cheap configuration/connectivity probe; never throws for the log driver. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

/** Shared `From:` rendering. Display names with specials are quoted, never injected raw. */
export function formatFrom(address: string, name: string): string {
  const clean = name.replace(/[\r\n"\\]/g, '').trim();
  if (!clean) return address;
  return /^[A-Za-z0-9 .'-]+$/.test(clean) ? `${clean} <${address}>` : `"${clean}" <${address}>`;
}

/**
 * Header values are built from case names and brand text, so a stray newline
 * must never become a second header.
 */
export function assertSafeHeader(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new MailError(`${what} must not contain line breaks`);
  return value;
}
