# Installation

[← back to the README](../README.md)

## Docker Compose (recommended)

```bash
cp .env.example .env
# set PUBLIC_URL to the address recipients will use (https://files.example.com)
# and configure MAIL_* — with the default MAIL_DRIVER=log no code ever leaves the machine
docker compose up -d --build
docker compose exec app node dist/cli.js create-admin admin      # password prompted, min. 12 characters
docker compose exec app node dist/cli.js test-mail you@example.com
```

After the first login enable two-factor authentication in the panel (**Security**) or
enforce it for every account with `ADMIN_REQUIRE_TOTP=true`. Everyone else gets an
account from that administrator under **Users** ([accounts and roles](security-model.md#permission-model)) — the CLI is only needed for the
first one.

Panel: `PUBLIC_URL/admin`. Data (the SQLite database and, with the local backend, the
files) lives on the `outletbox-data` volume mounted at `/data`.

There is no default password. The first administrator is created only through the CLI on
the server (the password can also be piped:
`echo "$PASS" | node dist/cli.js create-admin admin --password-stdin`).

## Local development

```bash
npm install
cp .env.example .env            # for http://localhost set COOKIE_SECURE=false
npm run cli -- create-admin admin
npm run dev                     # http://localhost:3000/admin
```

With `MAIL_DRIVER=log` every message is written to `DATA_DIR/mail/` as a plain text file,
so you can read the one-time code while testing the flow end to end.

## CLI

```bash
node dist/cli.js create-admin <user> [--password-stdin]
node dist/cli.js reset-password <user>      # also ends that admin's sessions
node dist/cli.js disable-totp <user>        # lost authenticator and recovery codes
node dist/cli.js test-mail <address>        # probe the configured mail driver
node dist/cli.js cleanup [--ttl-hours N]
node dist/cli.js migrate
```

## Upgrading

```bash
git fetch --tags && git checkout vX.Y.Z      # or pull the new image
docker compose up -d --build
```

That is the whole procedure. On start-up the application applies any pending database
migrations by itself — and **before it changes anything, it copies the database** to
`/data/backups/before-<migration>-<timestamp>.sqlite` (a `VACUUM INTO` copy, consistent even
while the database runs in WAL mode, checked with `PRAGMA integrity_check`, mode 0600). If
the copy cannot be made, the migration does not run and the container stops with the reason
in its log: an upgrade without a way back is not attempted. A start with nothing to migrate
copies nothing, and only the five newest copies are kept. Each migration runs in a
transaction, so a failed one leaves the database as it was.

Going back to the previous release: stop the container, put the copy in place of
`/data/outletbox.sqlite` (and delete `outletbox.sqlite-wal` / `-shm` next to it), then start
the previous image. Uploaded files are not touched by migrations.

Read the release's section in [CHANGELOG.md](../CHANGELOG.md) before upgrading; anything that
changes behaviour for administrators or recipients is listed there.
