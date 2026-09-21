-- The application never sends the delivery link itself: an administrator hands
-- it over out of band, and only the one-time code goes out by e-mail. The
-- column that recorded "the panel mailed this link" therefore has no meaning.
ALTER TABLE links DROP COLUMN link_sent_at;
