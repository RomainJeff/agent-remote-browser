// Persistent state: profiles, global token, OAuth clients and tokens. One JSON file, write-through.
// ponytail: single gateway process, sync writes, whole file rewritten. Upgrade: SQLite past a few hundred profiles.
// Saved login envelopes bind the password to its profile, site, URL and username.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { hash } from './policy.mjs';

const FILE = process.env.STATE_FILE || new URL('./data/state.json', import.meta.url).pathname;
const state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
state.profiles ??= {};   // id -> { allow, tokenHash, logins: { site: { url, username, password } }, createdAt }
state.clients ??= {};    // OAuth DCR clients: client_id -> { redirect_uris, client_name, secretHash?, createdAt }
state.tokens ??= {};     // hash -> { kind: 'access'|'refresh', principal, client, exp }
// state.globalTokenHash

export { state };
export function save() {
  writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 1), { mode: 0o600 });
  renameSync(FILE + '.tmp', FILE);
}

const keyFile = process.env.LOGIN_KEY_FILE || '/run/ac-keys/login.key';
const entries = Object.entries(state.profiles).flatMap(([id,p]) =>
  Object.entries(p.logins || {}).map(([site,c]) => ({id,site,c})));
if (!existsSync(keyFile)) {
  if (entries.some(({c}) => typeof c.password !== 'string')) throw Error('Restore the existing login key');
  writeFileSync(keyFile, randomBytes(32), {flag:'wx', mode:0o600});
}
const key = readFileSync(keyFile);
if (key.length !== 32) throw Error('Invalid login key');

export function encryptLogin(id,site,c,password) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(JSON.stringify([id,site,c.url,c.username])));
  const data = Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);
  return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}
export function decryptLogin(id,site,c) {
  const {iv,tag,data} = c.password;
  const cipher = createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify([id,site,c.url,c.username])));
  cipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
}
let migrated = false;
for (const {id,site,c} of entries) {
  if (typeof c.password === 'string') {
    c.password = encryptLogin(id,site,c,c.password);
    migrated = true;
  } else decryptLogin(id,site,c); // Fail before rewriting anything with a mismatched key.
}
if (migrated) save();

export const newToken = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const profile = (id) => (Object.hasOwn(state.profiles, id) ? state.profiles[id] : null);

/** principal = { global: true } | { profile: id }. Static tokens only (what a human pastes). */
export function principalForStatic(token) {
  if (typeof token !== 'string' || !token) return null;
  const h = hash(token);
  const matches = digest => typeof digest === 'string' && digest.length === h.length && timingSafeEqual(Buffer.from(digest,'ascii'),Buffer.from(h,'ascii'));
  if (state.globalTokenHash && matches(state.globalTokenHash)) return { global: true };
  const id = Object.keys(state.profiles).find((k) => matches(state.profiles[k].tokenHash));
  return id ? { profile: id } : null;
}

/** Bearer on /mcp: a static token, or an OAuth access token whose principal still exists. */
export function principalFor(token) {
  const p = principalForStatic(token);
  if (p || !token) return p;
  const t = state.tokens[hash(token)];
  if (!t || t.kind !== 'access' || t.exp < Date.now()) return null;
  return t.principal.global || profile(t.principal.profile) ? t.principal : null;
}

/** Drop every OAuth token issued for a principal (token regenerated, profile deleted). */
export function revoke(match) {
  for (const [h, t] of Object.entries(state.tokens)) if (match(t.principal)) delete state.tokens[h];
}

export const ACCESS_TTL = 3600_000, REFRESH_TTL = 30 * 86400_000;
export function issueTokens(principal, client) {
  const now = Date.now();
  for (const [h, t] of Object.entries(state.tokens)) if (t.exp < now) delete state.tokens[h];
  const access = newToken('aca'), refresh = newToken('acr');
  state.tokens[hash(access)] = { kind: 'access', principal, client, exp: now + ACCESS_TTL };
  state.tokens[hash(refresh)] = { kind: 'refresh', principal, client, exp: now + REFRESH_TTL };
  save();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh };
}
