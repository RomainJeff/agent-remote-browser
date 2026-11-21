// Leases: a global-token holder gets exclusive use of a profile for a while. While leased, the profile's own token
// is refused. ponytail: in memory, a gateway restart frees every lease. Lot 3 persists them in SQLite.
import { randomBytes } from 'node:crypto';

export interface Lease { profile: string; exp: number; ms: number }
export type Leases = ReturnType<typeof createLeases>;

export function createLeases() {
  const leases = new Map<string, Lease>(); // lease token -> lease

  /** The live lease on a profile, if any. Expired leases are dropped on the way. */
  function of(id: string) {
    for (const [k, l] of leases) {
      if (l.exp < Date.now()) leases.delete(k);
      else if (l.profile === id) return l;
    }
    return null;
  }

  return {
    of,
    drop: (id: string) => { for (const [k, l] of leases) if (l.profile === id) leases.delete(k); },
    take(id: string, minutes: number) {
      const token = `acl_${randomBytes(18).toString('base64url')}`, ms = minutes * 60_000;
      leases.set(token, { profile: id, exp: Date.now() + ms, ms });
      return { token, exp: Date.now() + ms };
    },
    /** A live lease by token; its expiry slides with each use. */
    use(token: string) {
      const l = leases.get(token);
      if (!l || l.exp < Date.now()) return null;
      l.exp = Date.now() + l.ms;
      return l;
    },
    release: (token: string) => leases.delete(token),
  };
}
