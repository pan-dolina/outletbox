-- A link can be shared by several people. Each of them still unlocks it with
-- their own address and a code sent to that address, so the address list moves
-- to its own table, and so does the language: it belongs to the person, not to
-- the link. Every existing link becomes a link with exactly one recipient.
CREATE TABLE link_recipients (
  id             TEXT PRIMARY KEY,
  link_id        TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,             -- normalised (lower case); the challenge is sent here
  lang           TEXT NOT NULL DEFAULT 'en',-- the code e-mail is written in it
  opens          INTEGER NOT NULL DEFAULT 0,-- informational; the limit is links.max_opens
  last_opened_at TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (link_id, email)
);

INSERT INTO link_recipients (id, link_id, email, lang, opens, last_opened_at, created_at)
  SELECT 'r_' || lower(hex(randomblob(8))), id, recipient_email, lang, opens_used,
         CASE WHEN opens_used > 0 THEN last_used_at END, created_at
  FROM links;

-- A code and the session it opens belong to one of those people. Deleting the
-- recipient takes both with it, which is what "remove this person" has to mean.
ALTER TABLE challenges ADD COLUMN recipient_id TEXT REFERENCES link_recipients(id) ON DELETE CASCADE;
ALTER TABLE access_sessions ADD COLUMN recipient_id TEXT REFERENCES link_recipients(id) ON DELETE CASCADE;
UPDATE challenges SET recipient_id = (SELECT r.id FROM link_recipients r WHERE r.link_id = challenges.link_id);
UPDATE access_sessions SET recipient_id = (SELECT r.id FROM link_recipients r WHERE r.link_id = access_sessions.link_id);
CREATE INDEX challenges_recipient_idx ON challenges(recipient_id, created_at);

ALTER TABLE links DROP COLUMN recipient_email;
ALTER TABLE links DROP COLUMN lang;

-- Address groups: named lists an administrator keeps for people who receive
-- deliveries together. A link *copies* the addresses when they are added, so
-- editing a group never changes who can open a link that already exists.
CREATE TABLE recipient_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipient_group_members (
  group_id TEXT NOT NULL REFERENCES recipient_groups(id) ON DELETE CASCADE,
  email    TEXT NOT NULL,
  lang     TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, email)
);
