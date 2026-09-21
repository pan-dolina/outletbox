import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import type { Mailer, OutgoingMail } from './types.js';

export interface RecordedMail extends OutgoingMail {
  at: string;
  from: string;
}

/**
 * The default driver: nothing leaves the machine. Messages are kept in a small
 * in-memory ring (what the test suite reads) and, when a spool directory is
 * configured, dropped there as plain text files so a developer can read the
 * code they were "sent".
 *
 * Neither the subject nor the body is logged: both carry the one-time code, and
 * stdout is the one place it must not end up.
 */
export class LogMailer implements Mailer {
  readonly kind = 'log' as const;
  private readonly ring: RecordedMail[] = [];

  constructor(private readonly from: string, private readonly spoolDir?: string, private readonly keep = 50) {}

  async send(msg: OutgoingMail): Promise<void> {
    const record: RecordedMail = { ...msg, from: this.from, at: new Date().toISOString() };
    this.ring.push(record);
    if (this.ring.length > this.keep) this.ring.shift();
    const file = this.spool(record);
    log.info('mail (log driver, not sent)', { to: msg.to, bytes: msg.text.length, file });
  }

  /** Best effort: a full spool directory must never break the unlock flow. */
  private spool(record: RecordedMail): string | undefined {
    if (!this.spoolDir) return undefined;
    try {
      fs.mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 });
      const name = `${record.at.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.txt`;
      const full = path.join(this.spoolDir, name);
      fs.writeFileSync(full, [`From: ${record.from}`, `To: ${record.to}`, `Subject: ${record.subject}`, `Date: ${record.at}`, '', record.text, ''].join('\n'), { mode: 0o600 });
      return full;
    } catch (err) {
      log.warn('mail: could not write to the spool directory', { err: err as Error });
      return undefined;
    }
  }

  /** Newest first. Test-only accessor; nothing in the request path reads it. */
  recent(): RecordedMail[] {
    return [...this.ring].reverse();
  }

  async verify(): Promise<void> { /* nothing to check */ }
  async close(): Promise<void> { /* nothing to close */ }
}
