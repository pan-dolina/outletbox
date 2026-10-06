-- Address groups remember who created them. Users may now keep groups of their
-- own: everyone can still pick any group for a link, but only its creator or an
-- administrator changes or deletes it. Groups from before this migration have no
-- creator and stay with the administrators; so does a group whose creator's
-- account is deleted.
ALTER TABLE recipient_groups ADD COLUMN created_by TEXT REFERENCES admins(id) ON DELETE SET NULL;
