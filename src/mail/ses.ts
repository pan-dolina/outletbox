import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { MailConfig } from '../config.js';
import { formatFrom, MailError, type Mailer, type OutgoingMail } from './types.js';

/**
 * Amazon SES v2. Credentials are optional: without them the SDK's default
 * provider chain is used, which is what an instance profile / IRSA role needs.
 */
export class SesMailer implements Mailer {
  readonly kind = 'ses' as const;
  private readonly client: SESv2Client;

  constructor(private readonly cfg: MailConfig) {
    this.client = new SESv2Client({
      region: cfg.ses.region,
      endpoint: cfg.ses.endpoint,
      credentials: cfg.ses.accessKeyId && cfg.ses.secretAccessKey
        ? { accessKeyId: cfg.ses.accessKeyId, secretAccessKey: cfg.ses.secretAccessKey }
        : undefined,
    });
  }

  async send(msg: OutgoingMail): Promise<void> {
    try {
      await this.client.send(new SendEmailCommand({
        FromEmailAddress: formatFrom(this.cfg.from, this.cfg.fromName),
        Destination: { ToAddresses: [msg.to] },
        ReplyToAddresses: this.cfg.replyTo ? [this.cfg.replyTo] : undefined,
        ConfigurationSetName: this.cfg.ses.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: msg.text, Charset: 'UTF-8' },
              ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }));
    } catch (err) {
      throw new MailError(`SES delivery failed: ${(err as Error).message}`, err);
    }
  }

  async verify(): Promise<void> {
    // SES has no cheap no-op call that does not send or cost anything; the
    // credentials are validated on the first real message instead.
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
