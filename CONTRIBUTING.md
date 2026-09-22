# Contributing

Thanks for looking. This is a small, opinionated project: a delivery box where the
security model is the product. Changes are welcome, but a patch that makes the code
prettier at the cost of one of the guarantees below will be declined.

## Before you start

Open an issue first for anything beyond a bug fix. It is cheaper to disagree about an
approach in a paragraph than in a pull request.

**Do not report vulnerabilities here.** See [SECURITY.md](SECURITY.md).

## Getting it running

Node 26 or newer is required — `engines` says so, the Docker image ships it, and CI tests
exactly that. There are no native modules.

```bash
npm install
cp .env.example .env            # for http://localhost set COOKIE_SECURE=false
npm run cli -- create-admin admin
npm run dev                     # http://localhost:3000/admin
```

Leave `MAIL_DRIVER=log` while developing: nothing is sent, and every message is written to
`DATA_DIR/mail/*.txt`, so you can read the one-time code and walk the whole recipient flow
locally. `npm run cli -- test-mail you@example.com` checks a real driver once you configure
one.

## The gate

These have to pass. CI runs all of them, so running them first saves a round trip.

```bash
npm run typecheck               # tsc --noEmit
npm test                        # vitest, local SQLite backend
npm run test:coverage           # same, with thresholds enforced (90/82/90/95)
docker run -d -p 127.0.0.1:9000:9000 quay.io/minio/minio server /data
TEST_S3=1 npm test              # the same suite against S3
docker build -t outletbox:local .
```

There is no lint script on purpose; typecheck and the tests are the gate.

### Tests

- Each test file boots a real HTTP server on a random port with its own temporary
  `DATA_DIR`, so files run in parallel safely. See `boot()` in `test/helpers.ts`.
- The recipient side has helpers: `Visitor` is a cookie jar that also carries the flow
  token, `unlock(app, url)` walks address → code → unlocked page, and `lastCode(app)`
  reads the code out of the log mailer. Use them instead of hand-rolling the dance.
- Mail drivers are tested against in-process fakes — a small SMTP server over `net` and
  HTTP servers standing in for Entra ID, Graph and SES. `GRAPH_AUTHORITY`,
  `GRAPH_API_BASE` and `SES_ENDPOINT` exist partly so that is possible; keep them.
- Assertions expect **English** strings by default. Send `accept-language: pl` for Polish.
- New behaviour needs a test. A bug fix needs a test that fails without it.
- Failure paths belong in `test/edges.test.ts` — that is where a regression leaks an
  internal message, a token or a code, and it is the file that exists to catch it.
- Touching auth, CSRF, the unlock flow or an upload error path? Re-run
  `test/security.test.ts`, `test/delivery.test.ts` and `test/totp.test.ts`.

Branch coverage sits lower than the rest (82) because what is left uncovered is defensive
plumbing. Do not add mock-driven tests just to move that number.

## Things that look like bugs and are not

The README has the full architecture; these are the ones people try to "fix" first:

- **A wrong e-mail address gets the same page as a right one**, and nothing is sent. The
  link must not become an oracle for who the delivery was addressed to. The address is
  never rendered on the recipient side either.
- **The one-time code is bound to the browser that requested it** (the `outletbox_flow`
  cookie). A code read out of somebody else's inbox cannot be typed in elsewhere. That
  cookie is also the double-submit CSRF token for the public forms.
- **Codes are hashed with scrypt, not SHA-256.** Six digits is a 10^6 space; a leaked
  database must not allow an instant sweep. The verification cost is the point.
- **An exhausted link still serves a session that is already open.** Being allowed in and
  then losing the files mid-download would be absurd. Revocation and closing the case do
  the opposite on purpose: they end live sessions at once.
- **The application mails the code and nothing else.** The delivery link is handed over
  by the administrator, deliberately on a different channel, so the two factors do not
  travel together. A "send the link by e-mail" button will be declined.
- **"Issue a new link" rotates the token.** The clear-text token exists only in the
  response that created it — the database has a hash — so there is nothing to re-send.
- **`Origin: null` is accepted on admin POSTs.** `Referrer-Policy: no-referrer` makes
  Chrome send it on same-origin form posts. Sec-Fetch-Site and the CSRF token are the real
  checks. Tightening this breaks same-site posts.
- **`TRUST_PROXY=true` is refused** by the config loader. Only a hop count or an address
  list is accepted, because `true` lets a client forge `X-Forwarded-For` and defeat the
  rate limits.
- **The token lives in the URL path** (`/d/<token>`), never a query string, and the logger
  redacts it. Query strings end up in access logs and `Referer` headers.
- **`urlencoded()` is mounted for forms only.** `curl --data-binary` announces
  `application/x-www-form-urlencoded`, and the body parser would silently swallow an
  upload.
- **The TOTP replay guard stores the last accepted step** and refuses that step or
  earlier. Tests clear it instead of sleeping 30 seconds; that is deliberate.
- **The dark theme never redefines `--primary`, `--topbar` or `--accent`.**
  `/brand/theme.css` sets those per instance and loads after `style.css`, so redefining
  them silently undoes an operator's branding.
- **`.queue progress` must not get `appearance: none`.** That removes the browser's native
  indeterminate animation, which is the signal that an upload is being finalised rather
  than stalled.

If one of these is genuinely wrong, say so in an issue with the case that breaks it.

## Style

Match the surrounding code: same comment density, same naming, same idiom. A comment
should say *why*, not restate the line below it.

Every view goes through the `html` tagged template in `src/http/html.ts`, which escapes
interpolations. Never build markup by concatenation — case names, item titles and note
bodies are shown to recipients. Mail subjects go through `assertSafeHeader`, because a
case name with a newline in it would otherwise become a second header.

Every i18n key must exist in all 24 dictionaries in `src/locales/`; `en.ts` defines the
keys and the types refuse a dictionary that lacks one. A new string therefore needs a
translation in every language — if you cannot write one, say so in the pull request
rather than pasting the English in, which `test/i18n.test.ts` notices. Strings used by
the browser uploader also have to be listed in `clientMessages()`, or they render as the
raw key.

Translations other than English and Polish have not been reviewed by native speakers. A
pull request that fixes wording in one of them is welcome on its own — the code e-mail
text (`mail.code.*`) matters most, since that is what a recipient reads first.

Never commit an instance's configuration or branding. `.env`, any `*.env`, `branding/`
and a logo at the repo root are ignored; `.env.example` is the only config in the repo and
holds nothing but commented-out placeholders.

## Commits and pull requests

- One logical change per commit. The subject line says what changes for a user or an
  operator; the body says why, and what you decided against.
- Keep the branch rebased on `main`.
- A change that a recipient, an administrator or an operator would notice needs an entry
  in [CHANGELOG.md](CHANGELOG.md), in the section of the version being prepared.
- Say in the PR what you ran and what you did not. "Tested locally" is not a test report.

## Releasing

Maintainers only: add the version's section to `CHANGELOG.md`, bump `version` in
`package.json`, commit, then push an annotated `vX.Y.Z` tag. The Release workflow turns
the tag into a GitHub Release whose notes are that changelog section, using the runner's
token — releases do not depend on anyone's laptop. It refuses a tag with no section.

Fixing a published release's notes means fixing `CHANGELOG.md` on `main`: the same
workflow rewrites the notes of every existing release whose section changed.
`.github/scripts/release-notes.sh vX.Y.Z` prints what a release will say, locally.
