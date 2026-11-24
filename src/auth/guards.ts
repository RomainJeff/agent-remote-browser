// Who is calling: the admin (Better Auth session, TOTP done) or an agent (OAuth access token / API key -> scope).
import type { IncomingHttpHeaders } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { hash, parseProfileId, type Principal } from '../policy.ts';
import type { Ctx } from '../server.ts';
import type { Store } from '../store/store.ts';
import { PREFIX, type Auth } from './better-auth.ts';

export function toHeaders(h: IncomingHttpHeaders) {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) if (v !== undefined) for (const x of [v].flat()) out.append(k, x);
  return out;
}

/** The admin session, only once TOTP is enrolled (sign-in creates no session before the TOTP step then). */
export async function requireAdmin(auth: Auth, headers: IncomingHttpHeaders) {
  const s = await auth.api.getSession({ headers: toHeaders(headers) }).catch(() => null);
  return s?.user.twoFactorEnabled ? s : null;
}

export function scopedProfile(store: Store, scope: unknown, user: string) {
  const id = typeof scope === 'string' && scope.startsWith('profile:') ? parseProfileId(scope.slice(8)) : null;
  return id && store.roleOf(id, user) ? id : null;
}

/** Resolve the bearer on each MCP request, using the holder's current account and memberships. */
export async function principal({ db, auth, store }: Pick<Ctx, 'db' | 'auth' | 'store'>, token: unknown, ip?: string): Promise<Principal | null> {
  if (typeof token !== 'string') return null;
  let scope: unknown, user: string | null | undefined;
  if (token.startsWith(PREFIX.access)) {
    // Same lookup as Better Auth's introspection: sha256 of the token without its prefix.
    const grant = db.prepare('SELECT userId, referenceId FROM oauthAccessToken WHERE token = ? AND revoked IS NULL AND expiresAt > ?')
      .get(hash(token.slice(PREFIX.access.length)), new Date().toISOString()) as { userId: string | null; referenceId: string | null } | undefined;
    scope = grant?.referenceId;
    user = grant?.userId;
  } else if (token.startsWith(PREFIX.apiKey)) {
    const r = await auth.api.verifyApiKey({ body: { key: token } }).catch(() => null);
    if (!r?.valid || !r.key) return null;
    scope = (r.key.metadata as { scope?: unknown } | null)?.scope;
    user = r.key.referenceId;
    db.prepare('UPDATE apikey SET lastIp = ? WHERE id = ?').run(ip ?? null, r.key.id);
  }
  if (!user) return null;
  const holder = db.prepare('SELECT id AS user, email FROM user WHERE id = ?').get(user) as { user: string; email: string } | undefined;
  if (!holder) return null;
  if (scope === 'global') return { ...holder, global: true };
  const profile = scopedProfile(store, scope, user);
  return profile ? { ...holder, profile } : null;
}

/** DCR leaves a client behind for every abandoned connection: drop the ones never granted anything after 24 h. */
export function purgeClients(db: DatabaseSync, now = Date.now()) {
  return Number(db.prepare(`DELETE FROM oauthClient WHERE createdAt < ? AND clientId NOT IN
    (SELECT clientId FROM oauthAccessToken UNION SELECT clientId FROM oauthRefreshToken UNION SELECT clientId FROM oauthConsent)`)
    .run(new Date(now - 86400_000).toISOString()).changes);
}
