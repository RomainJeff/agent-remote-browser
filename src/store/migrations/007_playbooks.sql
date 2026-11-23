-- Lot 10c: playbooks, admin-written notes per profile (one known path on one site), returned as-is to the agent.
CREATE TABLE playbooks (
  profile TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                -- slug, like a profile id
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 20480), -- trusted (admin, step-up). Store checks it first
  updated INTEGER NOT NULL,          -- ms epoch
  PRIMARY KEY (profile, name)
) STRICT;
