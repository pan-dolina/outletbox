# Tests and security scanning

[← back to the README](../README.md)

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
