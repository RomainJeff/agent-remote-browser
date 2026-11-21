// Persistent state: profiles, global token, OAuth clients and tokens. One JSON file, write-through.
// ponytail: single gateway process, sync writes, whole file rewritten. Lot 3 replaces it with SQLite (store/db.ts).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, parseProfileId, type Principal } from '../policy.ts';
import { loadLoginKey, encryptLogin, decryptLogin, type Envelope, type LoginRef } from './logins-crypto.ts';

export interface Login extends LoginRef { password: Envelope }
export interface Profile { allow: string[]; tokenHash: string | null; logins: Record<string, Login>; createdAt: number }
export interface OAuthClient { redirect_uris: string[]; client_name?: string; secretHash?: string; createdAt?: number }
export interface OAuthToken { kind: 'access' | 'refresh'; principal: Principal; client: string; exp: number }
export interface State {
  profiles: Record<string, Profile>;
  clients: Record<string, OAuthClient>;   // Dynamic Client Registration, by client_id
  tokens: Record<string, OAuthToken>;     // by sha256 of the token
  globalTokenHash?: string;
}

export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const ACCESS_TTL = 3600_000, REFRESH_TTL = 30 * 86400_000;

export type Store = ReturnType<typeof openStore>;

/** Loads the state file and the login key. Throws (fail fast) on a missing or wrong key for existing envelopes. */
export function openStore(file: string, keyFile: string) {
  const state: State = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  state.profiles ??= {};
  state.clients ??= {};
  state.tokens ??= {};

  function save() {
    writeFileSync(file + '.tmp', JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }

  // Legacy POC files may hold plaintext passwords: those are encrypted on load.
  const entries = Object.entries(state.profiles).flatMap(([id,p]) =>
    Object.entries(p.logins || {}).map(([site,c]) => ({id,site,c: c as LoginRef & { password: Envelope | string }})));
  const key = loadLoginKey(keyFile, entries.some(({c}) => typeof c.password !== 'string'));
  let migrated = false;
  for (const {id,site,c} of entries) {
    if (typeof c.password === 'string') {
      c.password = encryptLogin(key,id,site,c,c.password);
      migrated = true;
    } else decryptLogin(key,id,site,c as Login); // Fail before rewriting anything with a mismatched key.
  }
  if (migrated) save();

  const profile = (id: string) => (Object.hasOwn(state.profiles, id) ? state.profiles[id] : null);

  /** Static tokens only (what a human pastes). */
  function principalForStatic(token: unknown): Principal | null {
    if (typeof token !== 'string' || !token) return null;
    const h = hash(token);
    const matches = (digest: unknown) => typeof digest === 'string' && digest.length === h.length && timingSafeEqual(Buffer.from(digest,'ascii'),Buffer.from(h,'ascii'));
    if (state.globalTokenHash && matches(state.globalTokenHash)) return { global: true };
    const id = parseProfileId(Object.keys(state.profiles).find((k) => matches(state.profiles[k].tokenHash)));
    return id ? { profile: id } : null;
  }

  return {
    state, save, profile, principalForStatic,
    encryptLogin: (id: string, site: string, c: LoginRef, password: string) => encryptLogin(key,id,site,c,password),
    decryptLogin: (id: string, site: string, c: Login) => decryptLogin(key,id,site,c),

    /** Bearer on /mcp: a static token, or an OAuth access token whose principal still exists. */
    principalFor(token: unknown): Principal | null {
      const p = principalForStatic(token);
      if (p || !token) return p;
      const t = state.tokens[hash(token)];
      if (!t || t.kind !== 'access' || t.exp < Date.now()) return null;
      return t.principal.global || profile(t.principal.profile) ? t.principal : null;
    },

    /** Drop every OAuth token issued for a principal (token regenerated, profile deleted). */
    revoke(match: (p: Principal) => boolean) {
      for (const [h, t] of Object.entries(state.tokens)) if (match(t.principal)) delete state.tokens[h];
    },

    issueTokens(principal: Principal, client: string) {
      const now = Date.now();
      for (const [h, t] of Object.entries(state.tokens)) if (t.exp < now) delete state.tokens[h];
      const access = newToken('aca'), refresh = newToken('acr');
      state.tokens[hash(access)] = { kind: 'access', principal, client, exp: now + ACCESS_TTL };
      state.tokens[hash(refresh)] = { kind: 'refresh', principal, client, exp: now + REFRESH_TTL };
      save();
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh };
    },
  };
}
