import type { MailDriverKind } from '../config.js';

/**
 * An image carried inside the message and referenced from the HTML part as
 * `cid:<contentId>`. Mail clients render those without asking the reader to
 * "display remote content", and nothing is fetched from us, so the message
 * does not report back when it was opened.
 */
export interface InlineImage {
  contentId: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  /** Plain text body. Always present: it is what most recipients' clients show. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
  /** Referenced from the HTML part; only drivers with `inlineImages` receive them. */
  inlineImages?: InlineImage[];
}

export class MailError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MailError';
  }
}

export interface Mailer {
  readonly kind: MailDriverKind;
  /**
   * Whether this driver can carry `InlineImage`s. False for SES, whose simple
   * SendEmail call takes no attachments, so its messages link the logo from the
   * instance instead. The caller asks before building the message.
   */
  readonly inlineImages: boolean;
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
