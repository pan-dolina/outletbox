# Sending mail

[← back to the README](../README.md)

One interface, four drivers ([`src/mail/`](../src/mail/)). Every driver sends the same single
message: the one-time code. **The delivery link is never mailed by the application** — an
administrator copies it from the panel and passes it to the recipient the way they
normally reach them. A message that leaks therefore carries a code that is useless without
the link, and a link that leaks is useless without the mailbox. The message is written in
the language set for that recipient, not in the language of whoever asked for the code,
and it carries the instance branding.

**How the logo travels depends on the driver.** With `smtp` and `graph` it is attached to
the message and referenced as `cid:`, which every mail client renders without asking the
reader to allow remote content — and, just as importantly, without telling the instance
when the message was opened. **With `ses` the logo is linked from `PUBLIC_URL/brand/logo`
instead**: SESv2 `SendEmail` with simple content carries no attachments, and building raw
MIME by hand for one image is not worth the failure modes. An SES instance therefore needs
`PUBLIC_URL` to be reachable from the recipient's network for the logo to appear, and
readers who block remote images see the brand name in its place. The same fallback applies
whenever the logo file cannot be read or is larger than 512 KB — a logo that big has no
business travelling in every message.

| Driver | Use it for | Required settings |
|---|---|---|
| `log` (default) | development and dry runs — **nothing is sent**; codes land in `DATA_DIR/mail/` and in memory | none |
| `smtp` | any relay or submission service | `SMTP_HOST`, usually `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` |
| `graph` | Microsoft 365 with app-only OAuth (the supported path now that SMTP AUTH is being retired) | `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_SENDER` |
| `ses` | Amazon SES v2 | `SES_REGION`; keys optional (instance role / IRSA otherwise) |

- **SMTP** talks to port 587 with STARTTLS by default; `SMTP_SECURE=true` (or port 465) is
  implicit TLS. `SMTP_REQUIRE_TLS=true` (the default) refuses to send in the clear —
  turn it off only for a relay on localhost, and `SMTP_ALLOW_INSECURE_TLS=true` only for an
  internal relay with a self-signed certificate.
- **Microsoft 365**: register an application, grant it the **application** permission
  `Mail.Send` with admin consent, and restrict it to the one sender mailbox with an
  application access policy (`New-ApplicationAccessPolicy`) — otherwise the credentials can
  send as anybody in the tenant. Tokens are cached until a minute before they expire and
  dropped on 401/403. Sovereign clouds: override `GRAPH_AUTHORITY` and `GRAPH_API_BASE`.
- **SES**: the sender identity (or its domain) must be verified, and the account must be
  out of the sandbox to reach arbitrary recipients.
- A failing mail driver never stops the application from starting: it is logged, links and
  files stay reachable, only new codes cannot be sent. `node dist/cli.js test-mail <addr>`
  checks the configuration from the server itself.
- Mail failures are visible to the recipient ("the code could not be sent"). That is a
  deliberate trade: an operator-visible outage beats a silent one, at the cost of telling a
  visitor who is watching a broken relay that their address was the right one.
