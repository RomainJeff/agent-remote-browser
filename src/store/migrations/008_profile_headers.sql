-- Custom HTTP headers per profile, sent only to one origin (e.g. a staging bypass token). Values are secrets:
-- one AES-256-GCM envelope each, sealed with the login key (AAD: profile, origin, name), never returned.
CREATE TABLE profile_headers (
  profile TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,              -- https://host, no path
  name TEXT NOT NULL,                -- lowercased header name
  envelope TEXT NOT NULL,            -- JSON {iv, tag, data}
  key_id TEXT NOT NULL,
  PRIMARY KEY (profile, origin, name)
) STRICT;
