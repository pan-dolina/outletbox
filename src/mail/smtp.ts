import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { MailConfig } from '../config.js';
import { formatFrom, MailError, type Mailer, type OutgoingMail } from './types.js';

/**
 * Classic SMTP relay (submission on 587 with STARTTLS, implicit TLS on 465, or
 * an unauthenticated internal relay on 25). Credentials come from the
 * environment; nothing is read from the message.
 */
export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private readonly transport: Transporter;

  constructor(private readonly cfg: MailConfig) {
    const options: SMTPTransport.Options = {
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      requireTLS: !cfg.smtp.secure && cfg.smtp.requireTls,
      auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass ?? '' } : undefined,
      tls: cfg.smtp.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    };
    this.transport = nodemailer.createTransport(options);
  }

  async send(msg: OutgoingMail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: formatFrom(this.cfg.from, this.cfg.fromName),
        sender: this.cfg.from,
        replyTo: this.cfg.replyTo ?? undefined,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
    } catch (err) {
      throw new MailError(`SMTP delivery failed: ${(err as Error).message}`, err);
    }
  }

  async verify(): Promise<void> {
    try {
      await this.transport.verify();
    } catch (err) {
      throw new MailError(`SMTP server not reachable: ${(err as Error).message}`, err);
    }
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}
