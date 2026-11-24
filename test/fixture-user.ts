import type { DatabaseSync } from 'node:sqlite';

export function fixtureUser(db: DatabaseSync, id = 'owner') {
  db.prepare(`INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, 0, 0) ON CONFLICT (id) DO NOTHING`).run(id, id + '@example.com', id);
  return id;
}
