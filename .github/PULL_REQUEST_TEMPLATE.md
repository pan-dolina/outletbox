## What changes, and why

<!-- What a recipient, an administrator or an operator notices. The why matters more than the diff. -->

## What you ran

<!-- Delete what does not apply. Say what you skipped — that is more useful than a tick. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `TEST_S3=1 npm test` (against MinIO)
- [ ] `npm run test:coverage` (thresholds pass)
- [ ] `docker build .`
- [ ] Walked the recipient flow by hand (address → code → download)

## Checklist

- [ ] New behaviour has a test; a fix has a test that fails without it
- [ ] Any new i18n key exists in **both** `en` and `pl`, and in `clientMessages()` if the
      browser uploader uses it
- [ ] No token, one-time code, password, real recipient address or `.env` content in the
      diff, the tests or the description
- [ ] A change to mail, the unlock flow or the admin boundary says here what an attacker
      gains or loses
- [ ] Nothing from the "things that look like bugs and are not" list in
      [CONTRIBUTING.md](../CONTRIBUTING.md) was "fixed"
