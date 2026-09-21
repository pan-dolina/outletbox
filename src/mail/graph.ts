import type { MailConfig } from '../config.js';
import { log } from '../log.js';
import { MailError, type Mailer, type OutgoingMail } from './types.js';

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Microsoft 365 through the Graph API with an app-only (client credentials)
 * token — the supported path now that SMTP AUTH is being switched off in
 * Entra tenants.
 *
 * App registration: application permission `Mail.Send`, admin-consented, and
 * ideally an application access policy limiting it to the one sender mailbox
 * (`New-ApplicationAccessPolicy`), otherwise the app can send as anybody.
 */
export class GraphMailer implements Mailer {
  readonly kind = 'graph' as const;
  readonly inlineImages = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: MailConfig) {}

  private get scope(): string {
    // Sovereign clouds use their own resource host; derive it from the configured API base.
    const url = new URL(this.cfg.graph.apiBase);
    return `${url.protocol}//${url.host}/.default`;
  }

  private async accessToken(): Promise<string> {
    // 60 s of slack: a token that expires mid-flight would fail the send it was fetched for.
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const { tenantId, clientId, clientSecret, authority } = this.cfg.graph;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: this.scope, grant_type: 'client_credentials' });
    let res: Response;
    try {
      res = await fetch(`${authority}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MailError(`Graph token endpoint unreachable: ${(err as Error).message}`, err);
    }
    const json = await res.json().catch(() => ({})) as TokenResponse;
    if (!res.ok || !json.access_token) {
      // error_description contains the tenant-side reason (AADSTS…); the secret is never in it.
      throw new MailError(`Graph token request failed (HTTP ${res.status}): ${json.error_description ?? json.error ?? 'no token returned'}`);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async send(msg: OutgoingMail): Promise<void> {
    const token = await this.accessToken();
    const payload = {
      message: {
        subject: msg.subject,
        body: msg.html ? { contentType: 'HTML', content: msg.html } : { contentType: 'Text', content: msg.text },
        toRecipients: [{ emailAddress: { address: msg.to } }],
        ...(this.cfg.replyTo ? { replyTo: [{ emailAddress: { address: this.cfg.replyTo } }] } : {}),
        // Graph takes inline images as ordinary file attachments flagged
        // isInline; contentId is what `cid:` in the HTML resolves against.
        ...(msg.inlineImages?.length
          ? {
            attachments: msg.inlineImages.map((img) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: img.filename,
              contentType: img.contentType,
              contentBytes: img.content.toString('base64'),
              isInline: true,
              contentId: img.contentId,
            })),
          }
          : {}),
      },
      saveToSentItems: this.cfg.graph.saveToSentItems,
    };
    const url = `${this.cfg.graph.apiBase}/users/${encodeURIComponent(this.cfg.graph.sender)}/sendMail`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MailError(`Graph sendMail unreachable: ${(err as Error).message}`, err);
    }
    if (res.status === 401 || res.status === 403) {
      this.token = null; // a rotated secret or revoked consent: do not keep serving the dead token
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new MailError(`Graph sendMail failed (HTTP ${res.status}): ${detail}`);
    }
  }

  async verify(): Promise<void> {
    await this.accessToken();
    log.info('mail: Graph credentials accepted', { sender: this.cfg.graph.sender });
  }

  async close(): Promise<void> {
    this.token = null;
  }
}
