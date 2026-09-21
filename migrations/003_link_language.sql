-- The language a recipient is addressed in is a property of the recipient, not
-- of whoever happens to open the link: the administrator picks it when adding
-- the person, and the one-time code e-mail follows it. Existing links keep the
-- application default, which is what they were effectively using already.
ALTER TABLE links ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';
