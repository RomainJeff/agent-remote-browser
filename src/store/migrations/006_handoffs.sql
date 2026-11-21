-- Lot 9: an agent hands its browser to the admin (captcha, 2FA, consent) and waits. One open handoff per profile.
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,               -- h_ + 12 bytes base64url, shown to the agent and the admin
  profile TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lease_hash TEXT,                   -- leases.id_hash when opened (NULL for a profile token). No FK: the lease goes on release
  reason TEXT NOT NULL,              -- written by the agent: untrusted
  state TEXT NOT NULL CHECK (state IN ('pending','taken','done','failed','cancelled','expired')),
  note TEXT,                         -- written by the admin, returned to the agent
  created INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  taken INTEGER,
  ended INTEGER
) STRICT;
CREATE UNIQUE INDEX handoffs_open ON handoffs(profile) WHERE state IN ('pending','taken');
