// App state in SQLite, behind small typed functions: profiles, saved logins, settings, OAuth clients and tokens.
// Leases: mcp/leases.ts. Lot 4 replaces the OAuth functions and tables with Better Auth.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, parseProfileId, type Principal, type ProfileId } from '../policy.ts';
import { tx } from './db.ts';
import { loadLoginKey, keyId, encryptLogin, decryptLogin, type Envelope, type LoginRef } from './logins-crypto.ts';

export interface Login extends LoginRef { password: Envelope }
export interface Profile { id: ProfileId; allow: string[]; tokenHash: string | null; logins: Record<string, Login>; createdAt: number }
export interface OAuthClient { redirect_uris: string[]; client_name: string; secretHash: string | null; createdAt: number }

export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const ACCESS_TTL = 3600_000, REFRESH_TTL = 30 * 86400_000;

type Row = Record<string, any>;
export type Store = ReturnType<typeof openStore>;

/** Loads the login key for this database. Throws (fail fast) when saved logins need a missing or different key. */
export function openStore(db: DatabaseSync, keyFile: string) {
  const all = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as Row[];
  const one = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as Row | undefined;
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

  const kids = all('SELECT DISTINCT key_id FROM logins').map((r) => r.key_id as string);
  let key = loadLoginKey(keyFile, kids.length > 0), kid = keyId(key);
  if (kids.some((k) => k !== kid)) throw Error(`The login key at ${keyFile} (id ${kid}) does not match saved logins (${kids.join(', ')})`);

  const toProfile = (r: Row): Profile => ({
    id: r.id, allow: JSON.parse(r.allow_json), tokenHash: r.token_hash, createdAt: r.created_at,
    logins: Object.fromEntries(all('SELECT site, url, username, envelope FROM logins WHERE profile = ? ORDER BY site', r.id)
      .map((l) => [l.site, { url: l.url, username: l.username, password: JSON.parse(l.envelope) }])),
  });
  const profile = (id: string) => { const r = one('SELECT * FROM profiles WHERE id = ?', id); return r ? toProfile(r) : null; };
  const putLogin = (k: Buffer, id: string, site: string, c: LoginRef, password: string) =>
    run(`INSERT INTO logins (profile, site, url, username, envelope, key_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (profile, site) DO UPDATE SET url = excluded.url, username = excluded.username, envelope = excluded.envelope, key_id = excluded.key_id`,
      id, site, c.url, c.username, JSON.stringify(encryptLogin(k, id, site, c, password)), keyId(k));
  const setting = (name: string) => (one('SELECT value FROM settings WHERE name = ?', name)?.value as string | undefined) ?? null;
  const globalTokenHash = () => setting('global_token_hash');

  /** Static tokens only (what a human pastes). */
  function principalForStatic(token: unknown): Principal | null {
    if (typeof token !== 'string' || !token) return null;
    const h = hash(token);
    const matches = (digest: unknown) => typeof digest === 'string' && digest.length === h.length && timingSafeEqual(Buffer.from(digest, 'ascii'), Buffer.from(h, 'ascii'));
    if (matches(globalTokenHash())) return { global: true };
    // Index lookup on the sha256: timing can only tell about the digest, never the token.
    const id = parseProfileId(one('SELECT id FROM profiles WHERE token_hash = ?', h)?.id);
    return id ? { profile: id } : null;
  }

  return {
    profile, globalTokenHash, principalForStatic,
    profiles: () => all('SELECT * FROM profiles ORDER BY created_at, id').map(toProfile),
    createProfile: (id: ProfileId, allow: string[], tokenHash: string | null) =>
      run('INSERT INTO profiles (id, allow_json, token_hash, created_at) VALUES (?, ?, ?, ?)', id, JSON.stringify(allow), tokenHash, Date.now()),
    setAllow: (id: ProfileId, allow: string[]) => run('UPDATE profiles SET allow_json = ? WHERE id = ?', JSON.stringify(allow), id),
    setProfileToken: (id: ProfileId, tokenHash: string) => run('UPDATE profiles SET token_hash = ? WHERE id = ?', tokenHash, id),
    /** Logins, leases and OAuth tokens of the profile go with it (ON DELETE CASCADE). */
    deleteProfile: (id: ProfileId) => run('DELETE FROM profiles WHERE id = ?', id),

    saveLogin: (id: ProfileId, site: string, c: LoginRef, password: string) => putLogin(key, id, site, c, password),
    deleteLogin: (id: ProfileId, site: string) => run('DELETE FROM logins WHERE profile = ? AND site = ?', id, site),
    decryptLogin: (id: string, site: string, c: Login) => decryptLogin(key, id, site, c),

    /** Re-encrypts every login with newKey in one transaction (any failure = nothing changed). The store then uses newKey. */
    rotateLoginKey(newKey: Buffer) {
      const n = tx(db, () => {
        const rows = all('SELECT profile, site, url, username, envelope FROM logins');
        for (const l of rows) {
          const c = { url: l.url, username: l.username, password: JSON.parse(l.envelope) };
          putLogin(newKey, l.profile, l.site, c, decryptLogin(key, l.profile, l.site, c));
        }
        return rows.length;
      });
      key = newKey; kid = keyId(newKey);
      return n;
    },
    keyId: () => kid,

    setGlobalTokenHash: (h: string) => run('INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value', 'global_token_hash', h),

    client(id: string): OAuthClient | null {
      const r = one('SELECT * FROM oauth_clients WHERE id = ?', id);
      return r ? { redirect_uris: JSON.parse(r.redirect_uris_json), client_name: r.client_name, secretHash: r.secret_hash, createdAt: r.created_at } : null;
    },
    clientCount: () => one('SELECT count(*) AS n FROM oauth_clients')!.n as number,
    addClient: (id: string, c: Omit<OAuthClient, 'createdAt'>) =>
      run('INSERT INTO oauth_clients (id, redirect_uris_json, client_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        id, JSON.stringify(c.redirect_uris), c.client_name, c.secretHash, Date.now()),

    /** Bearer on /mcp: a static token, or an unexpired OAuth access token (deleted profiles take theirs along). */
    principalFor(token: unknown): Principal | null {
      const p = principalForStatic(token);
      if (p || !token) return p;
      const t = one("SELECT profile FROM oauth_tokens WHERE hash = ? AND kind = 'access' AND exp >= ?", hash(token), Date.now());
      return !t ? null : t.profile ? { profile: t.profile } : { global: true };
    },

    /** Drop every OAuth token of a principal (its static token was regenerated). */
    revokeTokens: (p: Principal) => (p.global ? run('DELETE FROM oauth_tokens WHERE profile IS NULL') : run('DELETE FROM oauth_tokens WHERE profile = ?', p.profile)),

    /** Single use: a valid refresh token for this client is deleted and its principal returned (rotation). */
    takeRefresh(token: unknown, client: string): Principal | null {
      const t = one("DELETE FROM oauth_tokens WHERE hash = ? AND kind = 'refresh' AND client = ? AND exp >= ? RETURNING profile", hash(token ?? ''), client, Date.now());
      return !t ? null : t.profile ? { profile: t.profile } : { global: true };
    },

    issueTokens(principal: Principal, client: string) {
      const now = Date.now(), access = newToken('aca'), refresh = newToken('acr');
      tx(db, () => {
        run('DELETE FROM oauth_tokens WHERE exp < ?', now);
        const add = 'INSERT INTO oauth_tokens (hash, kind, profile, client, exp) VALUES (?, ?, ?, ?, ?)';
        run(add, hash(access), 'access', principal.profile ?? null, client, now + ACCESS_TTL);
        run(add, hash(refresh), 'refresh', principal.profile ?? null, client, now + REFRESH_TTL);
      });
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh };
    },
  };
}
