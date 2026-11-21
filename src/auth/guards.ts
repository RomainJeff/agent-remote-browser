// Who is calling: the admin (Better Auth session, TOTP done) or an agent (OAuth access token / API key -> scope).
import type { IncomingHttpHeaders } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { hash, parseProfileId, type Principal } from '../policy.ts';
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

/** Bearer `arb_at_…` (OAuth) or `arb_k_…` (API key, also via x-api-key) -> the scope the admin granted.
 *  `ip`: the client IP as the listener settled it (clientIp in server.ts), kept as the key's last IP. */
export async function principal(db: DatabaseSync, auth: Auth, token: unknown, ip?: string): Promise<Principal | null> {
  if (typeof token !== 'string') return null;
  let scope: unknown;
  if (token.startsWith(PREFIX.access)) {
    // Same lookup as Better Auth's introspection: sha256 of the token without its prefix.
    scope = (db.prepare('SELECT referenceId FROM oauthAccessToken WHERE token = ? AND revoked IS NULL AND expiresAt > ?')
      .get(hash(token.slice(PREFIX.access.length)), new Date().toISOString()) as { referenceId: string | null } | undefined)?.referenceId;
  } else if (token.startsWith(PREFIX.apiKey)) {
    const r = await auth.api.verifyApiKey({ body: { key: token } }).catch(() => null);
    scope = r?.valid ? (r.key?.metadata as { scope?: unknown } | null)?.scope : null;
    if (r?.valid && r.key) db.prepare('UPDATE apikey SET lastIp = ? WHERE id = ?').run(ip ?? null, r.key.id);
  }
  if (scope === 'global') return { global: true };
  const id = typeof scope === 'string' && scope.startsWith('profile:') ? parseProfileId(scope.slice(8)) : null;
  return id && db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id) ? { profile: id } : null;
}

/** DCR leaves a client behind for every abandoned connection: drop the ones never granted anything after 24 h. */
export function purgeClients(db: DatabaseSync, now = Date.now()) {
  return Number(db.prepare(`DELETE FROM oauthClient WHERE createdAt < ? AND clientId NOT IN
    (SELECT clientId FROM oauthAccessToken UNION SELECT clientId FROM oauthRefreshToken UNION SELECT clientId FROM oauthConsent)`)
    .run(new Date(now - 86400_000).toISOString()).changes);
}
