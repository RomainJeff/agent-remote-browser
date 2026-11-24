CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER
) STRICT;

-- An expired invitation still reserves its email until revoked or replaced.
CREATE VIEW pending_emails AS SELECT email FROM invites WHERE used IS NULL;
