-- App tables. Lot 4 adds Better Auth's tables and drops oauth_clients / oauth_tokens / profiles.token_hash.
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  allow_json TEXT NOT NULL,          -- JSON array of allowed domains
  token_hash TEXT UNIQUE,            -- sha256 of the acp_ profile token, NULL = none issued
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE logins (
  profile TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  envelope TEXT NOT NULL,            -- AES-256-GCM {iv, tag, data}, AAD = [profile, site, url, username]
  key_id TEXT NOT NULL,              -- which login key encrypted it
  PRIMARY KEY (profile, site)
) STRICT;

CREATE TABLE leases (
  id_hash TEXT PRIMARY KEY,          -- sha256 of the acl_ lease token
  profile TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  exp INTEGER NOT NULL,
  ms INTEGER NOT NULL                -- sliding window: each use sets exp = now + ms
) STRICT;
CREATE INDEX leases_profile ON leases(profile);

CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  redirect_uris_json TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  secret_hash TEXT,                  -- NULL = public client (PKCE only)
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE oauth_tokens (
  hash TEXT PRIMARY KEY,             -- sha256 of the aca_ / acr_ token
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,  -- NULL = global principal
  client TEXT NOT NULL,
  exp INTEGER NOT NULL
) STRICT;
CREATE INDEX oauth_tokens_profile ON oauth_tokens(profile);
