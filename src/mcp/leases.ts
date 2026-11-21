// Leases: a global-token holder gets exclusive use of a profile for a while. While leased, the profile's own token
// is refused. Persisted (sha256 of the acl_ token only), so a gateway restart keeps them.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hash } from '../policy.ts';

export interface Lease { profile: string; exp: number; ms: number }
export type Leases = ReturnType<typeof createLeases>;

export function createLeases(db: DatabaseSync) {
  return {
    /** The live lease on a profile, if any. Expired leases are dropped on the way. */
    of(id: string) {
      db.prepare('DELETE FROM leases WHERE exp < ?').run(Date.now());
      return (db.prepare('SELECT profile, exp, ms FROM leases WHERE profile = ? LIMIT 1').get(id) as Lease | undefined) ?? null;
    },
    drop: (id: string) => { db.prepare('DELETE FROM leases WHERE profile = ?').run(id); },
    take(id: string, minutes: number) {
      const token = `acl_${randomBytes(18).toString('base64url')}`, ms = minutes * 60_000, exp = Date.now() + ms;
      db.prepare('INSERT INTO leases (id_hash, profile, exp, ms) VALUES (?, ?, ?, ?)').run(hash(token), id, exp, ms);
      return { token, exp };
    },
    /** A live lease by token; its expiry slides with each use. */
    use: (token: string) => (db.prepare('UPDATE leases SET exp = ? + ms WHERE id_hash = ? AND exp >= ? RETURNING profile, exp, ms')
      .get(Date.now(), hash(token), Date.now()) as Lease | undefined) ?? null,
    release: (token: string) => db.prepare('DELETE FROM leases WHERE id_hash = ?').run(hash(token)).changes > 0,
  };
}
