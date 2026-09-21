# outletbox

A private, self-hosted **delivery box** for sending files to clients. An administrator
creates a case, puts files and notes into it and issues a link for one recipient. Opening
that link is not enough: the recipient has to type **the e-mail address the delivery was
addressed to** and then a **one-time code sent to that address**. The number of openings
can be capped, and everything is logged.

It is the mirror image of [inletbox](https://github.com/pan-dolina/inletbox), which
collects files *from* external parties; outletbox hands them *out*. This is not a network
drive and not a sharing tool: no public links, no previews, no self-registration.

- **Stack:** Node.js 26+ (TypeScript, Express 5), SQLite (built-in `node:sqlite`), local
  disk or S3/MinIO storage, resumable admin uploads via the **tus** protocol. No native modules.
- **Mail:** SMTP, Microsoft 365 (Graph, app-only OAuth), Amazon SES, or a `log` driver that
  sends nothing and is the default.
- **Deployment:** one container + one volume; optional MinIO profile for S3 testing.
- **Admin 2FA:** TOTP (RFC 6238) with recovery codes, optionally enforced for every admin.
- **UI languages:** English and Polish, for the panel, the recipient pages and the e-mails.
  Each recipient is addressed in the language chosen when they were added.
- **Branding:** name, logo and colours apply to the panel, the recipient pages *and* the
  code e-mail, so the message and the page asking for the code look like one thing.
- **Light and dark theme:** follows `prefers-color-scheme`. No toggle, no script, no cookie.

---

## Table of contents

1. [Quick start](#1-quick-start)
2. [How a delivery works](#2-how-a-delivery-works)
3. [Permission model](#3-permission-model)
4. [Configuration](#4-configuration)
5. [Sending mail](#5-sending-mail)
6. [Storage and uploads](#6-storage-and-uploads)
7. [Reverse proxy](#7-reverse-proxy)
8. [Security](#8-security)
9. [Architecture and data model](#9-architecture-and-data-model)
10. [Tests and security scanning](#10-tests-and-security-scanning)
11. [Limitations and next steps](#11-limitations-and-next-steps)

---

## 1. Quick start

### Docker Compose (recommended)

```bash
cp .env.example .env
# set PUBLIC_URL to the address recipients will use (https://files.example.com)
# and configure MAIL_* — with the default MAIL_DRIVER=log no code ever leaves the machine
docker compose up -d --build
docker compose exec app node dist/cli.js create-admin admin      # password prompted, min. 12 characters
docker compose exec app node dist/cli.js test-mail you@example.com
```

After the first login enable two-factor authentication in the panel (**Security**) or
enforce it for every administrator with `ADMIN_REQUIRE_TOTP=true`.

Panel: `PUBLIC_URL/admin`. Data (the SQLite database and, with the local backend, the
files) lives on the `outletbox-data` volume mounted at `/data`.

There is no default password. The first administrator is created only through the CLI on
the server (the password can also be piped:
`echo "$PASS" | node dist/cli.js create-admin admin --password-stdin`).

### Local development

```bash
npm install
cp .env.example .env            # for http://localhost set COOKIE_SECURE=false
npm run cli -- create-admin admin
npm run dev                     # http://localhost:3000/admin
```

With `MAIL_DRIVER=log` every message is written to `DATA_DIR/mail/` as a plain text file,
so you can read the one-time code while testing the flow end to end.

### CLI

```bash
node dist/cli.js create-admin <user> [--password-stdin]
node dist/cli.js reset-password <user>      # also ends that admin's sessions
node dist/cli.js disable-totp <user>        # lost authenticator and recovery codes
node dist/cli.js test-mail <address>        # probe the configured mail driver
node dist/cli.js cleanup [--ttl-hours N]
node dist/cli.js migrate
```

---

## 2. How a delivery works

```
  admin                                        recipient
  ─────                                        ─────────
  create a case
  upload files / write notes
  add a recipient (label + e-mail + limits
   + the language they are addressed in)
  → link https://…/d/<token>                   opens the link
    (handed over by the administrator: in
     person, by chat, by their own e-mail —
     the application never sends it)
                                               types their e-mail address
                                               ── must equal the one in the case ──
                                               receives a 6-digit code by e-mail
                                               types the code
                                               ── one "opening" is counted ──
                                               sees the notes, downloads the files
                                               (session expires; link can be capped)
```

Design points behind that flow:

- **The link alone grants nothing.** A forwarded or intercepted URL cannot be opened
  without access to the recipient's mailbox. The address is typed rather than shown, so
  the page never reveals who the delivery was meant for.
- **A wrong address looks exactly like a right one.** The code form appears either way and
  nothing is sent unless the address matches, so the link is not an oracle for "who is
  this for".
- **The code is bound to the browser that asked for it** (a random `outletbox_flow`
  cookie). A code read out of the recipient's inbox by somebody else cannot be typed into
  a different browser.
- **One opening = one accepted code.** `max_opens` caps how many times the delivery may be
  unlocked; downloads inside a live session are not counted, and a session that was opened
  while an opening was still available is allowed to finish.
- **Every recipient has their own language.** The administrator picks it when adding the
  person — the form starts on the language the panel is being read in — and the code
  e-mail is written in it, whatever browser the code is later requested from. The delivery
  pages follow the same language until the visitor picks another one in the footer.
- **The code is typed into six boxes, one digit each.** The whole code can be pasted into
  any of them, and the form is submitted as soon as the sixth digit is there. The boxes
  are ordinary inputs posting under the same name, so the page still works with
  JavaScript switched off.
- **Revoking a link, or closing the case, ends any session already open**, immediately.
- The code is **never** written to the application log, never stored in clear (scrypt, the
  same work factor as an admin password) and never repeated in the audit trail.

---

## 3. Permission model

| Who | Can | Cannot |
|---|---|---|
| **Administrator** (cookie session, optional TOTP) | create/edit/close cases; upload files and write notes; issue, e-mail, rotate and revoke recipient links; set expiry and the opening cap; download and delete items; read the audit log | — |
| **Recipient** (link + address + one-time code) | see the case name and description, read the notes, download the files of **that** case while their session lasts | open the link without the address and the code; see other cases; upload, change or delete anything; reach the panel; learn the recipient address from the page |

**One case = one set of contents = many recipient links.** Every link of a case exposes the
same files and notes, each to its own address, with its own expiry and opening cap. If two
people must receive different files, they get two cases.

The application cannot tell apart people who share one mailbox: whoever can read the
recipient's e-mail can complete the challenge. If that matters, shorten the expiry, lower
`max_opens`, and check the audit log — every opening is recorded with its IP.

---

## 4. Configuration

Everything is configured through environment variables (`.env.example` lists them all; it
contains no secrets). Sizes: `1048576`, `500MB`, `2GB`, `512KiB` (binary units).

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Public address of the instance; used to build delivery links and as the CSRF origin. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | Listen address. |
| `TRUST_PROXY` | `false` | Number of reverse-proxy hops (usually `1`) or a list of proxy addresses/CIDRs. `true` is refused because it would let clients forge their IP. |
| `DATA_DIR` | `./data` | SQLite database (`outletbox.sqlite`), files (`files/`) and, for the log mail driver, `mail/`. |
| `MAIL_DRIVER` | `log` | `log`, `smtp`, `graph`, `ses` — see §5. |
| `MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` | — | Sender identity. `MAIL_FROM` must be a bare address. |
| `ACCESS_CODE_TTL_MINUTES` | `15` | How long a one-time code stays valid. |
| `ACCESS_SESSION_TTL_MINUTES` | `60` | How long a recipient stays unlocked after a valid code. |
| `MAX_CODE_ATTEMPTS` | `5` | Wrong codes before the challenge is destroyed and a new one must be requested. |
| `CHALLENGE_LIMIT_PER_LINK_PER_HOUR` | `5` | Codes that may be requested for one link per hour (anti mail-bombing). |
| `STORAGE_BACKEND` | `local` | `local` or `s3`. |
| `LOCAL_STORAGE_DIR` | `$DATA_DIR/files` | Directory for file objects (outside any public directory; must not contain the database). |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PART_SIZE` | — | S3 backend; `S3_FORCE_PATH_STYLE=true` for MinIO; part size ≥ 5MB. |
| `MAX_FILE_SIZE` | `10GB` | Maximum size of one uploaded file. |
| `UPLOAD_CHUNK_SIZE` | `32MB` | Size of one browser PATCH request; must fit the reverse proxy body limit. |
| `INCOMPLETE_UPLOAD_TTL_HOURS` | `24` | Unfinished uploads older than this are removed. |
| `CLEANUP_INTERVAL_MINUTES` | `30` | How often the in-process cleanup runs (`0` disables it; `node dist/cli.js cleanup` runs it manually). |
| `SESSION_TTL_HOURS` | `12` | Admin session lifetime. |
| `ADMIN_REQUIRE_TOTP` | `false` | Enforce TOTP: an admin without a second factor only sees the security page until they enrol. |
| `COOKIE_SECURE` | auto (`https` → `true`) | `false` only for plain-HTTP local development. |
| `LOGIN_RATE_LIMIT_PER_15MIN` | `10` | Failed logins (password or TOTP step) per IP. |
| `TOKEN_FAILURE_RATE_LIMIT_PER_15MIN` | `30` | Unknown tokens and failed unlock attempts per IP. |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | `600` | General request limit per IP on the recipient routes. |
| `BRAND_NAME`, `BRAND_LOGO_PATH`, `BRAND_COLOR_*`, `BRAND_FOOTER_TEXT` | — | Branding, see below. |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`. |

### Branding

The look can be adapted to an organisation without code changes: name (`BRAND_NAME`, also
the issuer in authenticator apps, the e-mail display name and the signature in messages),
logo (`BRAND_LOGO_PATH`: PNG/SVG/JPEG/WebP, served at `/brand/logo`), colours
(`BRAND_COLOR_PRIMARY`, `BRAND_COLOR_TOPBAR`, `BRAND_COLOR_ACCENT`; hex `#rrggbb` **in
quotes**, because an unquoted `#` starts a comment in `.env` files) and the footer text.
Colours are emitted as a generated stylesheet at `/brand/theme.css`, so the CSP stays free
of `unsafe-inline`. Keep the logo outside the repository (`branding/` is git-ignored) and
mount it into the container, e.g. `volumes: ["./branding:/branding:ro"]` +
`BRAND_LOGO_PATH=/branding/logo.png`.

The three `BRAND_COLOR_*` values are **not** touched by the dark theme, so pick values that
are legible on a light *and* a dark card.

---

## 5. Sending mail

One interface, four drivers ([`src/mail/`](src/mail/)). Every driver sends the same single
message: the one-time code. **The delivery link is never mailed by the application** — an
administrator copies it from the panel and passes it to the recipient the way they
normally reach them. A message that leaks therefore carries a code that is useless without
the link, and a link that leaks is useless without the mailbox. The message is written in
the language the link was issued in, not in the language of whoever asked for the code,
and it carries the instance branding: the logo is referenced from `PUBLIC_URL/brand/logo`,
so a recipient whose client blocks remote images sees the brand name in its place.

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

---

## 6. Storage and uploads

Files are uploaded by administrators, from the panel, with the **tus** protocol
(`@tus/server` + `tus-js-client`, both served from this instance — no CDN). Large files are
sent in `UPLOAD_CHUNK_SIZE` chunks, retried on network errors and resumed after a broken
connection; after a page reload the same file has to be picked again (a browser cannot
reopen a file by itself), and the upload then continues from the last offset.

Scripts can use the plain streaming endpoint instead:

```bash
curl --fail-with-body -X PUT \
  -H "Cookie: outletbox_sid=<session>" -H "X-CSRF-Token: <token>" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://files.example.com/admin/api/cases/<caseId>/upload/report.pdf'
```

Storage abstraction in [`src/storage/types.ts`](src/storage/types.ts): `put` (streaming
with a byte counter and SHA-256), `get`, `stat`, `delete`, `createTusStore`,
`removeTusSidecar`, `cleanupOrphans`, `healthCheck`. Keys are validated
(`^[A-Za-z0-9_-]{1,128}$`), so there is no path traversal.

- **local** — `LOCAL_STORAGE_DIR`, written with the `wx` flag (never overwrites an existing
  key) and mode `0600` in a `0700` directory.
- **s3** — `@aws-sdk/lib-storage` for direct uploads, `@tus/s3-store` for tus. The bucket
  must be private; the application exposes neither presigned URLs nor credentials.
  Required permissions: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`,
  `s3:AbortMultipartUpload`, `s3:ListBucketMultipartUploads`, `s3:ListMultipartUploadParts`.

Cleanup (`runCleanup`, every `CLEANUP_INTERVAL_MINUTES` and via the CLI):
1. unfinished uploads older than the TTL → data removed, status `expired`;
2. `ready` files whose object disappeared → status `missing` (shown in the panel);
3. storage artefacts with no database record → removed; only keys in the application's own
   format are ever touched;
4. expired admin sessions, expired recipient sessions and challenges older than an hour.

---

## 7. Reverse proxy

The application does not terminate TLS. Settings **required** for large uploads and streaming:

- no body size limit (or ≥ `UPLOAD_CHUNK_SIZE`);
- **request buffering off**;
- long read/send timeouts (hours for large files);
- `TRUST_PROXY=1` in the application, `X-Forwarded-For`/`-Proto` set by the proxy.

### nginx

```nginx
# Redact the token from /d/<token> in the access log.
map $request_uri $redacted_uri {
    ~^(?<pre>/d/)[^/?]+(?<post>.*)$  "${pre}[redacted]${post}";
    default                          $request_uri;
}
log_format redacted '$remote_addr - [$time_local] "$request_method $redacted_uri $server_protocol" '
                    '$status $body_bytes_sent "$http_user_agent"';

server {
    listen 443 ssl http2;
    server_name files.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    access_log /var/log/nginx/outletbox.log redacted;

    client_max_body_size 0;            # limits are enforced by the application
    proxy_request_buffering off;       # stream uploads to the application
    proxy_buffering off;               # stream downloads to the recipient
    proxy_http_version 1.1;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

### Caddy

```caddyfile
files.example.com {
    request_body { max_size 0 }
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
        transport http { read_timeout 1h  write_timeout 1h }
    }
    log {
        output file /var/log/caddy/outletbox.log
        format filter {
            request>uri replace "/d/[^/?]+" "/d/[redacted]"
        }
    }
}
```

Node: the application disables the default 5-minute `requestTimeout` (it would cut long
uploads) but keeps `headersTimeout` at 60 s and a 5-minute socket idle timeout (slowloris).

---

## 8. Security

- **Recipient authentication:** possession of the link + knowledge of the address it was
  issued for + control of that mailbox. The address is compared after NFKC normalisation
  and lower-casing; a mismatch produces the same page as a match. Codes are six digits from
  a CSPRNG (rejection sampling, no modulo bias), stored as scrypt hashes, valid for
  `ACCESS_CODE_TTL_MINUTES`, single use, destroyed after `MAX_CODE_ATTEMPTS` wrong tries,
  bound to the browser that requested them, and rate-limited per link and per IP.
- **Recipient sessions:** random 256-bit id in an `HttpOnly; SameSite=Lax; Secure` cookie,
  only its SHA-256 in the database, short TTL, destroyed on revocation, on case closure and
  on request ("close the session").
- **Login:** passwords hashed with `scrypt` (N=2¹⁵, r=8, p=1, 16-byte salt); constant-time
  verification even for unknown users; minimum 12 characters.
- **Second factor (TOTP, RFC 6238):** own implementation on `node:crypto`, compatible with
  Aegis/Google Authenticator/1Password. Enrolment produces 8 one-time recovery codes. After
  the password the session is "pending" and can reach nothing but the code form; the
  session id rotates once the code passes. 5 wrong codes destroy the session; 10 wrong
  codes lock the account's second factor for 15 minutes. The accepted time step is
  remembered, so a code cannot be replayed.
- **Link tokens:** 256 bits from a CSPRNG, stored only as SHA-256 (+ a 6-character hint for
  the panel). The full link is shown once, in the response that created it, and can only be
  replaced — "issue a new link" rotates the token and kills the old one, along with any
  session opened with it.
- **CSRF:** SameSite=Lax + `Origin`/`Sec-Fetch-Site` checks + a per-session synchroniser
  token in every admin form (`X-CSRF-Token` for uploads) and a double-submit flow cookie on
  the recipient forms, which also stops a third party from triggering code e-mails.
- **Rate limiting:** failed logins, unknown tokens, unlock attempts, general request volume.
- **File names:** NFC normalisation, path components stripped, control characters removed,
  255-character limit; never used to build a storage path; every HTML interpolation is
  escaped (own `html` tagged template); `Content-Disposition` is built by
  `content-disposition` (RFC 5987/6266). Mail headers reject line breaks, so a case name
  cannot inject a `Bcc:`.
- **Downloads** are always `attachment`, `application/octet-stream`, `nosniff`,
  `CSP: default-src 'none'; sandbox`, `Cache-Control: no-store` — nothing is rendered.
- **IDOR:** identifiers are random (96 bits) and every access checks the owner; an item id
  from another case is a 404 even with a valid session.
- **Headers:** helmet, CSP `default-src 'none'; script-src 'self'; style-src 'self'; …`
  (no `unsafe-inline`), `Referrer-Policy: no-referrer` (the token does not leak through the
  referrer), `X-Frame-Options: DENY`.
- **Logs:** JSON on stdout; `/d/<token>` paths, `code=`/`token=` parameters and uploaded
  file names are redacted; `Authorization`/`Cookie`/`code`/`email` fields are dropped
  outright. The `log` mail driver logs neither subject nor body, because both carry the code.
- **Audit log** (panel → "Audit log"): logins and second-factor events, case/item/link
  operations, e-mail mismatches, codes sent, openings granted, downloads, cleanup — with the
  client IP, and never a token or a code.
- **Files are untrusted.** Antivirus scanning is **not part of this version**. The
  integration point is `completeUpload` in [`src/services/items.ts`](src/services/items.ts),
  called from both upload paths, which could set a `quarantined` status before an item
  becomes visible to recipients.

---

## 9. Architecture and data model

A single-process Express + SQLite monolith; storage and mail are plug-ins.

```
src/
  config.ts            environment variables → Config (parseSize, mail, branding, …)
  i18n.ts              en/pl dictionaries, Accept-Language negotiation, placeholders
  db.ts                node:sqlite, migrations from migrations/*.sql, transaction()
  crypto.ts            ids, tokens, access codes, sha256, scrypt, e-mail normalisation
  totp.ts              RFC 6238 TOTP, base32, recovery codes
  log.ts               JSON logging + redaction
  mail/                types (interface), log, smtp, graph, ses, templates
  storage/             types (interface), local, s3, limit (byte counter + hash)
  services/            auth, cases, items (files + notes), links, access (challenges,
                       recipient sessions), audit, cleanup
  http/
    app.ts             application assembly, static assets, /lang/:lang switcher, 404/500
    brand.ts           /brand/logo, /brand/theme.css
    middleware.ts      helmet/CSP, logger, sessions, CSRF, flow cookie, rate limits
    admin.ts           panel (SSR forms), login + second factor, upload API
    tus.ts             @tus/server + hooks (admin-authenticated)
    deliver.ts         /d/<token>: address → code → package → downloads
    html.ts, views/    escaping tagged template, views
  server.ts            http.Server (timeouts, 100-continue), periodic cleanup, shutdown
  cli.ts               create-admin, reset-password, disable-totp, migrate, cleanup, test-mail
public/                style.css, admin.js, admin-upload.js (tus client), otp.js (code boxes)
```

Tables ([`migrations/001_init.sql`](migrations/001_init.sql)):

- `admins`, `admin_recovery_codes`, `sessions` — as in inletbox (TOTP secret, replay guard,
  lockout counters, pending/verified sessions)
- `cases` (id, name, description, status open|closed)
- `items` (id = storage key = tus id, case_id, kind file|note, title, body, upload_kind,
  status uploading|ready|aborted|expired|missing|deleted, declared_size, size, sha256,
  created_by, timestamps)
- `links` (id, case_id, label, recipient_email, token_hash, token_hint, expires_at,
  revoked_at, max_opens, opens_used, lang, last_used_at)
- `challenges` (id, link_id, code_hash, flow_hash, attempts, expires_at, consumed_at, ip)
- `access_sessions` (id_hash, link_id, csrf_token, expires_at, ip)
- `audit_log` (ts, actor_type admin|recipient|system, actor_id, action, case_id, link_id,
  item_id, ip, details)

Recipient routes: `GET /d/<token>` (address form → code form → the delivery),
`POST /d/<token>/email`, `POST /d/<token>/code`, `POST /d/<token>/restart`,
`POST /d/<token>/close`, `GET /d/<token>/files/<itemId>`.

---

## 10. Tests and security scanning

```bash
npm test                    # local backend (SQLite + a temporary directory per test file)
npm run test:coverage       # the same suite with a V8 coverage report (thresholds enforced)
docker compose --profile minio up -d minio
TEST_S3=1 npm test          # the same suite against MinIO (a temporary bucket per test file)
npm run typecheck
```

The suite (vitest, 151 tests) boots a real HTTP server on a random port and covers: the
whole recipient flow (right and wrong address, wrong codes, attempt budget, expiry, codes
bound to one browser, opening caps, revocation, case closure, downloads and their
isolation); the panel (cases, notes, uploads, deletion, links, rotation, e-mailing, expiry
validation); admin uploads over tus (create/patch/head, wrong offset, idempotent
finalisation, cancellation, resume with `tus-js-client`) and streaming PUT (chunked bodies,
mid-stream rejection, torn connections); all four **mail drivers** against in-process fake
SMTP/Entra/Graph/SES servers; TOTP (RFC vectors, replay, lockouts, recovery codes, enforced
enrolment); security headers, cookies, CSRF on both sides, rate limits, path traversal;
branding; language negotiation and the cookie switcher; cleanup and failure paths.

Coverage is enforced (`npm run test:coverage`); current run: **92% statements, 83% branches,
95% functions, 96% lines**. `src/server.ts` and `src/cli.ts` are excluded as process entry
points, and `src/storage/s3.ts` is measured in the `TEST_S3=1` run instead.

Every push and pull request also runs `npm audit --audit-level=high`, CodeQL
(`security-extended`), gitleaks over tree and history, Trivy filesystem and image scans, and
Dependabot keeps npm/actions/docker up to date.

---

## 11. Limitations and next steps

- **No antivirus scanning** and no quarantine (see §8).
- Single process / single node: SQLite and the in-memory tus lock. Horizontal scaling would
  need PostgreSQL and a Redis-based tus locker.
- Every link of a case sees the whole case. Per-recipient subsets would need an item↔link
  mapping; today the answer is "one case per set of contents".
- No delivery receipts beyond the audit log, and no notification to the sender when a
  recipient opens the package. The natural hook is the `access.granted` audit event.
- SHA-256 is computed for streaming uploads; for tus it could be added after finalisation.
- One administrator role; no SSO/WebAuthn (TOTP is available), no permission levels.
- Only English and Polish strings exist; adding a language means one more dictionary in
  `src/i18n.ts` (the type system enforces that every key is translated).

---

## Contributing and reporting

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to run it, what the gate is, and the list of
  things that look like bugs and are not.
- [SECURITY.md](SECURITY.md) — **do not report vulnerabilities in a public issue**; use
  [private reporting](https://github.com/pan-dolina/outletbox/security/advisories/new).
  What is in scope and what is not is spelled out there.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — short, and enforced.

---

## License

Apache License 2.0, see [LICENSE](LICENSE).
