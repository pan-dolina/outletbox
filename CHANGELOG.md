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

[0.3.0]: https://github.com/pan-dolina/outletbox/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/pan-dolina/outletbox/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/pan-dolina/outletbox/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pan-dolina/outletbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pan-dolina/outletbox/releases/tag/v0.1.0
