# Security policy

outletbox hands files to people outside your organisation, and the only thing between a
delivery and the internet is a link, an e-mail address and a six-digit code. A flaw here
is a flaw in a trust boundary. Reports are welcome and will be taken seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/pan-dolina/outletbox/security/advisories/new).
It creates a private thread visible only to you and the maintainers, and it can become a
published advisory with a CVE once a fix is out.

Useful things to include, as far as you have them:

- the version (it is in the page footer, e.g. `v0.3.0`), the storage backend (local or S3)
  and the mail driver (`log`, `smtp`, `graph`, `ses`);
- whether the instance runs behind a reverse proxy, and what `TRUST_PROXY` is set to;
- what an attacker gains — opening a delivery without the address or the code, reading
  another case's items, reaching the admin panel, having the application mail somebody
  else, something else;
- the smallest reproduction you can manage: a request, a sequence of steps, a file name.

You will get an acknowledgement within a few days. This is a small project without a paid
security team, so please allow reasonable time for a fix before disclosing publicly.

There is no bug bounty.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x | yes |
| 0.2.x and older | no — upgrade, the upgrade path is a redeploy |

The project is pre-1.0 and fixes land on `main`. There are no backport branches: a
security fix ships in the next release, and the supported way to take it is to redeploy.

## What is in scope

Anything that breaks one of the guarantees the application is built on:

- unlocking a delivery without the recipient's address **and** a code sent to it —
  including guessing the address from the page's behaviour, replaying or brute-forcing a
  code, or using a code in a browser that did not request it;
- exceeding the opening cap, or keeping access after a link is revoked, expires, or its
  case is closed;
- a recipient reaching items of another case, or any route of the admin panel;
- a token, a code or a recipient address appearing somewhere it should not — a log line,
  the audit view, a page a recipient can see;
- making the instance send mail to an address of your choosing, or injecting headers into
  a message it sends;
- defeating the TOTP second factor, the session rotation, or the CSRF protection on either
  side;
- stored or reflected XSS, path traversal into the storage directory, SSRF from the S3 or
  mail configuration.

## What is not

- Findings that require an operator to misconfigure the instance in a way the
  documentation warns against — for example setting `TRUST_PROXY=true`, which the config
  loader refuses outright, or pointing `MAIL_DRIVER` at a relay that accepts anything.
- The fact that whoever can read the recipient's mailbox can open the delivery. That is
  the design: the mailbox is the second factor. Shorten the expiry and the opening cap if
  that is not enough for a given case.
- A mail outage being visible to the recipient. The error tells somebody watching a broken
  relay that the address they typed was the right one; a silent failure was judged worse,
  and it is documented in the README.
- Missing hardening headers on endpoints that serve no content.
- Reports from automated scanners with no demonstrated impact.
- Anything about the deployment of a particular instance rather than this code.

## How this code is checked

Every push runs, alongside the test suite: `npm audit`, CodeQL (`security-extended`),
gitleaks over the working tree and the full git history, and Trivy scans of both the
repository and the built image. Dependabot watches npm, GitHub Actions and Docker.
`test/security.test.ts`, `test/delivery.test.ts` and `test/totp.test.ts` are the
regression net for the unlock flow and the admin boundary.

None of that replaces a human finding something. Please report.
