# Architecture, storage and data model

[← back to the README](../README.md)

## Architecture and data model

A single-process Express + SQLite monolith; storage and mail are plug-ins.

```
src/
  config.ts            environment variables → Config (parseSize, mail, branding, …)
  i18n.ts              language list, Accept-Language negotiation, placeholders
  locales/             one dictionary per language; en.ts defines the keys
  db.ts                node:sqlite, migrations from migrations/*.sql, transaction()
  crypto.ts            ids, tokens, access codes, sha256, scrypt, e-mail normalisation
  totp.ts              RFC 6238 TOTP, base32, recovery codes
  log.ts               JSON logging + redaction
  mail/                types (interface), log, smtp, graph, ses, templates
  storage/             types (interface), local, s3, limit (byte counter + hash)
  services/            auth, users (roles, case assignments), cases, items (files + notes),
                       links, access (challenges, recipient sessions), audit, cleanup
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

Tables ([`migrations/`](../migrations/)):

- `admins`, `admin_recovery_codes`, `sessions` — as in inletbox (every panel account with
  its role admin|user, disabled_at, must_change_password, last_login_at; TOTP secret,
  replay guard, lockout counters, pending/verified sessions)
- `case_members` (case_id, admin_id) — which user may work on which case
- `cases` (id, name, description, status open|closed)
- `items` (id = storage key = tus id, case_id, kind file|note, title, body, upload_kind,
  status uploading|ready|aborted|expired|missing|deleted, declared_size, size, sha256,
  created_by, timestamps)
- `links` (id, case_id, label, token_hash, token_hint, expires_at, revoked_at, max_opens,
  opens_used, last_used_at) — the URL and the limits, shared by everyone on the link
- `link_recipients` (id, link_id, email, lang, opens, last_opened_at) — the people who may
  open it, each with their own language
- `recipient_groups`, `recipient_group_members` (email, lang) — address groups, copied into
  a link when used
- `challenges` (id, link_id, recipient_id, code_hash, flow_hash, attempts, expires_at,
  consumed_at, ip)
- `access_sessions` (id_hash, link_id, recipient_id, csrf_token, expires_at, ip)
- `audit_log` (ts, actor_type admin|recipient|system, actor_id, action, case_id, link_id,
  item_id, ip, details)

Recipient routes: `GET /d/<token>` (address form → code form → the delivery),
`POST /d/<token>/email`, `POST /d/<token>/code`, `POST /d/<token>/restart`,
`POST /d/<token>/close`, `GET /d/<token>/files/<itemId>`.

## Storage and uploads

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

Storage abstraction in [`src/storage/types.ts`](../src/storage/types.ts): `put` (streaming
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

## Limitations and next steps

- **No antivirus scanning** and no quarantine (see [Security](security-model.md#security)).
- Single process / single node: SQLite and the in-memory tus lock. Horizontal scaling would
  need PostgreSQL and a Redis-based tus locker.
- Every link of a case sees the whole case. Per-recipient subsets would need an item↔link
  mapping; today the answer is "one case per set of contents".
- No delivery receipts beyond the audit log, and no notification to the sender when a
  recipient opens the package. The natural hook is the `access.granted` audit event.
- SHA-256 is computed for streaming uploads; for tus it could be added after finalisation.
- Two roles and per-case assignment; no finer permissions inside a case (e.g. read-only),
  no SSO/WebAuthn (TOTP is available).
- English and Polish are maintained by people who read them. The other 22 dictionaries
  were translated without review by a native speaker; corrections are welcome and are a
  one-file change in `src/locales/`. Adding a language means one more dictionary there
  plus an entry in `src/i18n.ts` — the types refuse a missing key, and
  `test/i18n.test.ts` refuses a dropped `{placeholder}`.
