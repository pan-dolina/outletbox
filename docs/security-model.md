# Permissions and security model

[← back to the README](../README.md)

## Permission model

| Who | Can | Cannot |
|---|---|---|
| **Administrator** (cookie session, optional TOTP) | everything a user can, in **every** case; change or delete any address group; create, disable and delete accounts, change roles, issue new passwords, remove a lost second factor; assign users to cases; read the audit log | change their own role, disable or delete themselves |
| **User** (cookie session, optional TOTP) | in the cases they are **assigned** to: edit/close cases; upload files and write notes; issue, rotate and revoke recipient links; add and remove the people on a link (address groups included); set expiry and the opening cap; download and delete items; assign other users to the case and unassign them. Create new cases (and are assigned to them); create address groups and change or delete their own | see or open any other case — it answers `404`, exactly like one that does not exist; unassign themselves; change someone else's address group; manage accounts; read the audit log |
| **Recipient** (link + address + one-time code) | see the case name and description, read the notes, download the files of **that** case while their session lasts | open the link without the address and the code; see other cases; upload, change or delete anything; reach the panel; learn the recipient address from the page |

Every account that existed before 0.5.0 is an administrator. An administrator creates
further accounts under **Users** and picks a role; the application generates a temporary
password (20 characters, shown once) that its owner must replace before they can do
anything else. Assigning someone to a case happens on the case page, under **Assigned
users**, and anyone who works on the case can do it: assign another active user, or
unassign one. Nobody can unassign themselves (that would lock them out of the page they
are on), and administrators are never listed there, because they see every case. The access
rule lives in one function (`canAccessCase` in `src/services/users.ts`) and is checked on
every route that takes a case, link, item or upload id, including tus and the streaming
upload API. Role changes, unassignments and disabling take effect on the account's next
request, not at its next login. The instance always keeps at least one active
administrator, and no one can change their own account from the list — their password
and 2FA are on **Security**. `ADMIN_REQUIRE_TOTP` applies to every account.

Address groups are shared: everyone can see every group and pick it for a link. Anyone
can create one; it can then be changed or deleted only by the account that created it and
by administrators. Groups from before 0.6.0, and groups whose creator's account was
deleted, are kept by the administrators. Since a group only copies addresses into a link,
editing one never changes who can open a link that already exists.

**One case = one set of contents = one or more links, each for one or more people.** Every
link of a case exposes the same files and notes; each link has its own URL, expiry and
opening cap, shared by everyone on it. Give people separate links when they need
different expiries or limits, or when revoking one of them must not affect the others. If
two people must receive different files, they get two cases.

The application cannot tell apart people who share one mailbox: whoever can read the
recipient's e-mail can complete the challenge. If that matters, shorten the expiry, lower
`max_opens`, and check the audit log — every opening is recorded with its IP.

## Security

- **Recipient authentication:** possession of the link + knowledge of an address it was
  issued for + control of that mailbox. The address is compared after NFKC normalisation
  and lower-casing; a mismatch produces the same page as a match. Codes are six digits from
  a CSPRNG (rejection sampling, no modulo bias), stored as scrypt hashes, valid for
  `ACCESS_CODE_TTL_MINUTES`, single use, destroyed after `MAX_CODE_ATTEMPTS` wrong tries,
  bound to the browser that requested them, and rate-limited per recipient of a link and
  per IP.
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
  integration point is `completeUpload` in [`src/services/items.ts`](../src/services/items.ts),
  called from both upload paths, which could set a `quarantined` status before an item
  becomes visible to recipients.
