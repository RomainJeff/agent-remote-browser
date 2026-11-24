CREATE TABLE profile_members (
  profile TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY (profile, user_id)
) STRICT;

INSERT INTO profile_members SELECT p.id, a.user_id, 'admin' FROM profiles p, admins a;
