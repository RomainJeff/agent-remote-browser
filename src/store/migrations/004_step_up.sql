-- Step-up (Lot 7b): when this admin session last proved a second factor, and failed proofs since.
CREATE TABLE step_up (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,      -- ms epoch, 0 = never
  fails INTEGER NOT NULL DEFAULT 0
) STRICT;
