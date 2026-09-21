import path from 'node:path';
import type { Config } from '../config.js';
import { GraphMailer } from './graph.js';
import { LogMailer } from './log.js';
import { SesMailer } from './ses.js';
import { SmtpMailer } from './smtp.js';
import type { Mailer } from './types.js';

export * from './types.js';
export { LogMailer, type RecordedMail } from './log.js';
export { GraphMailer } from './graph.js';
export { SesMailer } from './ses.js';
export { SmtpMailer } from './smtp.js';

export function createMailer(cfg: Config): Mailer {
  switch (cfg.mail.driver) {
    case 'smtp': return new SmtpMailer(cfg.mail);
    case 'graph': return new GraphMailer(cfg.mail);
    case 'ses': return new SesMailer(cfg.mail);
    // The spool makes the "log" driver usable for real local testing: the code
    // lands in a file under DATA_DIR/mail instead of only in memory.
    default: return new LogMailer(cfg.mail.from, path.join(cfg.dataDir, 'mail'));
  }
}
