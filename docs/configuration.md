# Configuration

[← back to the README](../README.md)

Everything is configured through environment variables (`.env.example` lists them all; it
contains no secrets). Sizes: `1048576`, `500MB`, `2GB`, `512KiB` (binary units).

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Public address of the instance; used to build delivery links and as the CSRF origin. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | Listen address. |
| `TRUST_PROXY` | `false` | Number of reverse-proxy hops (usually `1`) or a list of proxy addresses/CIDRs. `true` is refused because it would let clients forge their IP. |
| `DATA_DIR` | `./data` | SQLite database (`outletbox.sqlite`), files (`files/`) and, for the log mail driver, `mail/`. |
| `MAIL_DRIVER` | `log` | `log`, `smtp`, `graph`, `ses` — see [Sending mail](mail.md). |
| `MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` | — | Sender identity. `MAIL_FROM` must be a bare address. |
| `ACCESS_CODE_TTL_MINUTES` | `15` | How long a one-time code stays valid. |
| `ACCESS_SESSION_TTL_MINUTES` | `60` | How long a recipient stays unlocked after a valid code. |
| `MAX_CODE_ATTEMPTS` | `5` | Wrong codes before the challenge is destroyed and a new one must be requested. |
| `CHALLENGE_LIMIT_PER_LINK_PER_HOUR` | `5` | Codes that may be requested per hour by one person on a link (anti mail-bombing). |
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

## Branding

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

## Interface languages

The panel, the recipient pages and the code e-mail are available in the 24 official
languages of the European Union. There is nothing to configure. The panel follows the
browser's primary language (`Accept-Language`) if it is one of the 24, and English
otherwise. The footer has a menu listing every language by its own name; a choice made
there is stored in a cookie and always wins. Recipients are addressed in the language set
for them on the link, as described in [How a delivery works](delivery.md).
