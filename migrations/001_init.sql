-- outletbox: administrators publish files and notes inside a case; each recipient
-- link is unlocked with the recipient's own e-mail address plus a one-time code
-- sent to that address.

CREATE TABLE admins (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  totp_secret       TEXT,                   -- base32 secret; set while pending, kept once enabled
  totp_enabled_at   TEXT,                   -- NULL = 2FA not enabled
  totp_last_step    INTEGER,                -- last accepted time step (replay protection)
  totp_failed_count INTEGER NOT NULL DEFAULT 0,
  totp_locked_until TEXT
);

CREATE TABLE admin_recovery_codes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id  TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TEXT
);
CREATE INDEX admin_recovery_codes_admin_idx ON admin_recovery_codes(admin_id);

-- A session is created after the password check; it becomes usable for the panel
-- only once totp_verified = 1 (or the admin has no TOTP enabled).
CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  admin_id      TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  totp_verified INTEGER NOT NULL DEFAULT 0,
  totp_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE cases (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('open', 'closed')) DEFAULT 'open',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- What the recipient receives: uploaded files and plain-text notes.
CREATE TABLE items (
  id            TEXT PRIMARY KEY,            -- for files also the storage key and the tus upload id
  case_id       TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('file', 'note')),
  title         TEXT NOT NULL,               -- file name or note title
  body          TEXT,                        -- note text (NULL for files)
  upload_kind   TEXT CHECK (upload_kind IN ('tus', 'direct')),
  status        TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'aborted', 'expired', 'missing', 'deleted')),
  declared_size INTEGER,                     -- size announced by the uploader (NULL if unknown)
  size          INTEGER,                     -- final size once ready
  sha256        TEXT,
  created_by    TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  ready_at      TEXT,
  deleted_at    TEXT
);
CREATE INDEX items_case_idx ON items(case_id, status);
CREATE INDEX items_status_created_idx ON items(status, created_at);

-- One link = one recipient = one e-mail address that has to be typed back.
CREATE TABLE links (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  recipient_email TEXT NOT NULL,            -- normalised (lower case); the challenge is sent here
  token_hash      TEXT NOT NULL UNIQUE,
  token_hint      TEXT NOT NULL,            -- first characters of the token, for display only
  expires_at      TEXT,                     -- NULL = never
  revoked_at      TEXT,
  max_opens       INTEGER,                  -- NULL = unlimited
  opens_used      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT,
  link_sent_at    TEXT                      -- when the link itself was e-mailed from the panel
);
CREATE INDEX links_case_idx ON links(case_id);

-- One-time codes. A row is created when the recipient typed the right address;
-- it is bound to that browser (flow_hash) and dies after a few wrong codes.
CREATE TABLE challenges (
  id          TEXT PRIMARY KEY,
  link_id     TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  flow_hash   TEXT NOT NULL,                -- SHA-256 of the per-browser flow cookie
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  ip          TEXT
);
CREATE INDEX challenges_link_idx ON challenges(link_id, created_at);
CREATE INDEX challenges_expires_idx ON challenges(expires_at);

-- Short-lived recipient session created once a code was accepted.
CREATE TABLE access_sessions (
  id_hash    TEXT PRIMARY KEY,
  link_id    TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT
);
CREATE INDEX access_sessions_expires_idx ON access_sessions(expires_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'recipient', 'system')),
  actor_id   TEXT,
  action     TEXT NOT NULL,
  case_id    TEXT,
  link_id    TEXT,
  item_id    TEXT,
  ip         TEXT,
  details    TEXT                          -- JSON
);
CREATE INDEX audit_ts_idx ON audit_log(ts);
