# Changelog

Notable changes per release, written for whoever runs this — so entries say what
changes for an operator, an administrator or a recipient, not which files moved. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The section for a version is what ends up in its
[GitHub Release](https://github.com/pan-dolina/outletbox/releases):
`.github/workflows/release.yml` reads it from this file, refuses to publish a tag that
has no section here, and rewrites a published release's notes whenever its section
changes on `main`.

## [0.5.0] - 2026-09-30

### Added

- **Accounts with roles, and cases assigned to people.** An administrator creates
  accounts under **Users** and gives each one a role. An *administrator* sees every case,
  manages accounts and reads the audit log. A *user* sees only the cases they are
  assigned to, and inside those can do everything an administrator can do with the case
  itself — files, notes, links and the people on them, closing it. Any other case answers exactly as if it did not exist. Users can open new
  cases, and are assigned to the ones they open. Assignments are made on the case page,
  under **Assigned users**.
- A new account gets a generated temporary password, shown to the administrator once; its
  owner has to replace it before they can do anything else. From the same list an
  administrator can change a role, issue a new password, remove a lost second factor,
  disable an account (it is signed out at once and keeps its history) or delete it. A
  change applies on the account's next request, not at its next sign-in. Nobody changes
  their own account there, and the instance always keeps one active administrator.
- The audit log names the account behind each entry, not only its id.

### Changed

- **Every existing account becomes an administrator** (migration `005_users`), so an
  instance behaves as before until someone creates a user. `ADMIN_REQUIRE_TOTP` now
  applies to every account, users included.
- Changing your own password refuses the current one as the new one.
- **Address groups are kept by administrators.** Users pick from them when they add
  recipients, but only an administrator creates, edits or deletes one.
- The migration runs under the automatic pre-upgrade copy introduced in 0.4.1, so the
  upgrade is a redeploy.

## [0.4.1] - 2026-09-30

### Added

- **Upgrades back the database up by themselves.** Before a pending migration changes
  anything, the application copies the database to
  `DATA_DIR/backups/before-<migration>-<timestamp>.sqlite` — a `VACUUM INTO` copy, which
  is consistent even in WAL mode (copying the `.sqlite` file alone is not), checked with
  `PRAGMA integrity_check`. If the copy cannot be made, the migration does not run and
  the start-up stops with the reason in the log. The five newest copies are kept; a start
  with nothing to migrate copies nothing. README → *Upgrading* describes the procedure and
  the way back.

### Changed

- The container image no longer contains `npm`/`npx`. The application and its CLI run on
  `node` alone (`node dist/cli.js …`, as documented); the npm bundled with the base image
  was never used and carried the vulnerabilities that made the image scan fail.
- The optional `minio` Compose profile now uses Chainguard's MinIO image
  (`cgr.dev/chainguard/minio`). MinIO's own images can no longer be pulled without an
  account, so `docker compose --profile minio up` failed.

### Upgrading

- From 0.3.x, go straight to this release rather than 0.4.0: it takes the backup that
  0.4.0 asked you to take by hand.

## [0.4.0] - 2026-09-30

### Added

- **One link can be shared by several people.** A link now carries a list of addresses —
  typed one per line, separated by commas or semicolons, or pasted straight from a mail
  client ("Anna Schmidt <anna@…>; …"). Everyone on the list opens the same URL, and each
  of them still has to type their own address and the code sent to it, so forwarding the
  link to somebody who is not on the list gets them nowhere.
- People can be added to an existing link, and removed from it, without the URL
  changing. Removing someone ends their open session and invalidates a code they were
  about to type; the others are not affected.
- **Address groups** (new "Address groups" page in the panel): named lists such as
  "Board" or "External auditors" that can be picked when creating a link or adding
  people to one. A group is copied into the link at that moment — editing or deleting
  the group later never changes who can open a link that already exists.
- The delivery page says which address the session was opened with ("Signed in as …"),
  and the panel shows, per person, how many times they opened the link.

### Changed

- **Language is set per person, not per link.** Each address can carry its own language
  code ("anna@example.com de"); addresses without one take the language picked in the
  form. The code e-mail is always written in the person's language. The delivery pages
  switch to it once that person has signed in; before that they speak it only when
  everyone on the link shares one language, and otherwise follow the browser — the page
  must not change language according to the address typed, since that would reveal
  whether the address was on the list.
- **The opening limit counts the link as a whole**, whoever opened it: a link for five
  people with a limit of 3 can be opened three times in total.
- **`CHALLENGE_LIMIT_PER_LINK_PER_HOUR` now applies per person on a link.** For a link
  with one recipient nothing changes; on a shared link one person asking for codes
  repeatedly cannot lock the others out. Likewise, requesting a new code only cancels
  the pending code of the same person.
- The audit log names the person behind every code request, opening and download.

### Upgrading

- The database migration (`004_shared_links.sql`) runs on start-up and turns every
  existing link into a link with its one recipient, keeping their language, the opening
  count and any code or session in progress. Back up the database first; the migration
  cannot be undone without that backup. (0.4.1 takes that backup automatically — upgrade
  straight to it.)

## [0.3.1] - 2026-09-28

### Fixed

- The footer names the product next to its release: "outletbox v0.3.1" rather than a
  bare "v0.3.1" after the operator's own footer text, which made the version read as
  the brand's. Without `BRAND_FOOTER_TEXT`, the instance name is left out when it would
  only repeat "outletbox".

## [0.3.0] - 2026-09-22

### Added

- **The interface speaks all 24 official languages of the European Union** — the panel,
  the recipient pages and the code e-mail. A recipient can now be added in any of them.
  English and Polish are maintained by people who read them; the other 22 have not yet
  been reviewed by native speakers, and corrections are welcome — the wording of the
  code e-mail matters most.
- The footer language switcher is now a menu listing each language by its own name
  (Deutsch, Français, Ελληνικά…). It works without JavaScript, like the rest of the page.
- The project mark appears in the top bar, opposite the operator's own branding.

### Changed

- **Administrators may see the panel in a different language than before.** It used to
  be Polish only for browsers set to Polish first and English for everyone else; it now
  follows the browser's first language whenever it is one of the 24, so a German browser
  gets German. A language the browser only lists further down is still ignored in favour
  of English. Recipients are unaffected: they keep getting the language their link was
  issued in.
- Dates are written the way the chosen language writes them.

## [0.2.2] - 2026-09-21

### Changed

- **The logo travels inside the code e-mail** on SMTP and Microsoft 365 (Graph), as an
  inline attachment, instead of being linked from the instance. The recipient no longer
  has to allow remote images to see it, and the instance no longer learns when a message
  was opened. SES cannot carry attachments through the API used here and keeps linking
  the logo from `PUBLIC_URL`; so does any instance whose logo is over 512 KB.

## [0.2.1] - 2026-09-21

### Changed

- The code e-mail carries the instance branding — the same dark band, logo and accent
  colour as the delivery page — so the message and the page asking for the code are
  recognisably one thing.
- Notes are shown in a monospace face, on the recipient's page and in the panel preview:
  they carry passwords, keys and paths that someone retypes, where 0 and O, l and 1 must
  differ.

### Fixed

- Webmail that shows the HTML part of the e-mail on its own could garble non-ASCII text
  ("Dzień" became "DzieÅ„"); the part now declares its charset.

## [0.2.0] - 2026-09-21

### Changed

- **The application never e-mails the delivery link any more.** An administrator copies
  it from the panel and hands it to the recipient over the channel they already use, so
  the link and the code travel separately and a compromised mailbox alone opens nothing.
  The "e-mail the link" option and the "send a new link" action are gone; "issue a new
  link" still rotates a leaked link, and sends nothing. Migration `002` drops the column
  that recorded sent links; existing links and their opening counts are kept.
- **Each recipient has their own language**, chosen when they are added (migration
  `003`). The code e-mail is written in it whatever browser later asks for the code, and
  the delivery pages follow it until the visitor picks another language.
- The one-time code is typed into six boxes, one digit each; a pasted code is spread
  across them. The form still works with JavaScript switched off.
- **Node 26 is now the minimum.** Operators using the Docker image are unaffected.

### Fixed

- The README warns that Docker Compose silently truncates a secret containing an
  unescaped `$` in an `env_file` — which surfaced only as "535 authentication failed"
  from the mail server.

## [0.1.0] - 2026-09-21

### Added

- First release: an administrator publishes files and notes in a case and issues one
  link per recipient. Holding the link is not access — the recipient types the e-mail
  address the delivery was addressed to, then a one-time code sent to that address.
- A wrong address gets exactly the same page as a right one and nothing is sent, so a
  link does not reveal whom it was meant for. Codes are single use, stored hashed, bound
  to the browser that asked for them and rate limited; `max_opens` caps how many times a
  delivery can be unlocked.
- Mail through SMTP, Microsoft 365 (Graph), Amazon SES, or a `log` driver that sends
  nothing — the default, so a fresh instance cannot mail a real person by accident.
- Admin login with TOTP and recovery codes, local or S3 storage, resumable uploads,
  branding, an audit log, English and Polish.
- Apache-2.0.

[0.5.0]: https://github.com/pan-dolina/outletbox/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/pan-dolina/outletbox/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/pan-dolina/outletbox/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/pan-dolina/outletbox/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/pan-dolina/outletbox/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/pan-dolina/outletbox/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/pan-dolina/outletbox/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pan-dolina/outletbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pan-dolina/outletbox/releases/tag/v0.1.0
