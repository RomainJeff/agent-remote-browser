// Handoffs: an agent asks the admin to act in its browser (captcha, 2FA, consent) and its browser tools pause until
// the admin ends it. One open handoff per profile. Expiry and cancellation (lease gone) are applied lazily on read.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Audit } from '../audit.ts';
import { count, observe } from '../metrics.ts';

export type HandoffState = 'pending' | 'taken' | 'done' | 'failed' | 'cancelled' | 'expired';
export interface Handoff {
  id: string; profile: string; lease_hash: string | null; reason: string; state: HandoffState; note: string | null;
  created: number; deadline: number; taken: number | null; ended: number | null;
}
export type Handoffs = ReturnType<typeof createHandoffs>;

const OPEN = "state IN ('pending','taken')";
const KEEP_MS = 30 * 86_400_000;

export function createHandoffs(db: DatabaseSync, audit: Audit) {
  const end = (id: string, state: HandoffState, note: string | null = null) => {
    const now = Date.now();
    const h = db.prepare(`UPDATE handoffs SET state = ?, note = ?, ended = ? WHERE id = ? AND ${OPEN} RETURNING *`)
      .get(state, note, now, id) as Handoff | undefined;
    if (!h) return null;
    count('arb_handoff_total', { outcome: state });
    observe('arb_handoff_seconds', { outcome: state }, (now - h.created) / 1000);
    // The lease was frozen until the deadline: it slides again from now.
    if (h.lease_hash) db.prepare('UPDATE leases SET exp = ? + ms WHERE id_hash = ?').run(now, h.lease_hash);
    return h;
  };

  /** The open handoff on a profile, after applying a lost lease (cancelled) or a passed deadline (expired). */
  const open = (profile: string) => {
    const h = db.prepare(`SELECT * FROM handoffs WHERE profile = ? AND ${OPEN}`).get(profile) as Handoff | undefined;
    if (!h) return null;
    const now = Date.now();
    const lost = h.lease_hash && !db.prepare('SELECT 1 FROM leases WHERE id_hash = ? AND exp >= ?').get(h.lease_hash, now);
    const state = lost ? 'cancelled' : h.deadline < now ? 'expired' : null;
    if (!state) return h;
    if (end(h.id, state)) audit({ agent: profile, tool: `handoff:${state}`, ok: true });
    return null;
  };

  return {
    open,
    /** A new pending handoff, or null when one is already open on this profile. Freezes the lease until the deadline. */
    request(profile: string, leaseHash: string | null, reason: string, minutes: number) {
      const now = Date.now(), deadline = now + minutes * 60_000, id = `h_${randomBytes(12).toString('base64url')}`;
      db.prepare('DELETE FROM handoffs WHERE ended < ?').run(now - KEEP_MS);
      if (open(profile)) return null;
      try {
        db.prepare("INSERT INTO handoffs (id, profile, lease_hash, reason, state, created, deadline) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
          .run(id, profile, leaseHash, reason, now, deadline);
      } catch (e) {
        if (/UNIQUE/.test(String((e as Error).message))) return null; // raced another request
        throw e;
      }
      if (leaseHash) db.prepare('UPDATE leases SET exp = MAX(exp, ? + ms) WHERE id_hash = ?').run(deadline, leaseHash);
      return db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as unknown as Handoff;
    },
    take: (id: string) => (db.prepare("UPDATE handoffs SET state = 'taken', taken = ? WHERE id = ? AND state = 'pending' RETURNING *")
      .get(Date.now(), id) as Handoff | undefined) ?? null,
    finish: (id: string, state: 'done' | 'failed', note: string | null) => end(id, state, note),
    /** The caller's latest handoff on this profile (open or ended), lazy transitions applied first. */
    last(profile: string, leaseHash: string | null) {
      open(profile);
      return (db.prepare('SELECT * FROM handoffs WHERE profile = ? AND lease_hash IS ? ORDER BY created DESC, rowid DESC LIMIT 1')
        .get(profile, leaseHash) as Handoff | undefined) ?? null;
    },
  };
}
