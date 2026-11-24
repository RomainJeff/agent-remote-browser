// App state in SQLite, behind small typed functions: profiles, saved logins, custom headers, playbooks.
// Leases: mcp/leases.ts. Identity, OAuth and API keys: Better Auth (auth/), same database.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { validId, urlAllowed, type ProfileId, type Role } from '../policy.ts';
import { tx } from './db.ts';
import { loadLoginKey, keyId, encryptLogin, decryptLogin, seal, unseal, type Envelope, type LoginRef } from './logins-crypto.ts';

export interface Login extends LoginRef { password: Envelope; lastTestedAt?: number | null; lastResult?: string | null }
export interface Profile { id: ProfileId; allow: string[]; logins: Record<string, Login>; createdAt: number }

type Row = Record<string, any>;
export interface Playbook { name: string; body: string; updated: number }

export const PLAYBOOK_MAX = 20 * 1024;
/** Why this playbook cannot be saved, or null. */
export function badPlaybook(name: unknown, body: unknown): string | null {
  if (!validId(name)) return 'Name: lowercase letters, digits and dashes, 1 to 40 characters';
  if (typeof body !== 'string' || !body.trim()) return 'Body is required';
  if (Buffer.byteLength(body) > PLAYBOOK_MAX) return `Body is over ${PLAYBOOK_MAX / 1024} KB`;
  return null;
}
/** First non-empty line, without its Markdown heading marks. */
export const describe = (body: string) => (body.split('\n').find((l) => l.trim()) ?? '').replace(/^\s*#+\s*/, '').trim().slice(0, 200);

/** Header names the browser or the egress proxy own: never set by a profile. */
const RESERVED = /^(host|content-length|connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|proxy-.*)$/;
/** The JSON object agent-browser gets for one origin stays under this (the runner caps an argv element at 5000). */
export const HEADERS_MAX = 4000;
/** Why this header cannot be saved, or null. `origin` must already be normalized (see headerOrigin). */
export function badHeader(origin: string | null, name: unknown, value: unknown, allow: readonly string[]): string | null {
  if (!origin || !urlAllowed(origin, allow)) return 'Origin: https://host of an allowed domain, no path';
  if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name)) return 'Name: a header name like X-Bypass-Token';
  if (RESERVED.test(name.toLowerCase())) return `${name} is set by the browser`;
  if (typeof value !== 'string' || !/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) || value.length > 2000) return 'Value: printable ASCII, no leading or trailing space, 2000 characters max';
  return null;
}
/** "https://host" or "https://host/" -> "https://host"; anything else (path, query, port, http) -> null. */
export function headerOrigin(raw: unknown) {
  try { const u = new URL(String(raw)); return u.protocol === 'https:' && [u.origin, u.origin + '/'].includes(String(raw)) ? u.origin : null; }
  catch { return null; }
}

export type Store = ReturnType<typeof openStore>;

/** Loads the login key for this database. Throws (fail fast) when saved logins need a missing or different key. */
export function openStore(db: DatabaseSync, keyFile: string) {
  const all = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as Row[];
  const one = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as Row | undefined;
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

  const kids = all('SELECT key_id FROM logins UNION SELECT key_id FROM profile_headers').map((r) => r.key_id as string);
  let key = loadLoginKey(keyFile, kids.length > 0), kid = keyId(key);
  if (kids.some((k) => k !== kid)) throw Error(`The login key at ${keyFile} (id ${kid}) does not match saved logins or headers (${kids.join(', ')})`);

  const toProfile = (r: Row): Profile => ({
    id: r.id, allow: JSON.parse(r.allow_json), createdAt: r.created_at,
    logins: Object.fromEntries(all('SELECT site, url, username, envelope, last_tested_at, last_result FROM logins WHERE profile = ? ORDER BY site', r.id)
      .map((l) => [l.site, { url: l.url, username: l.username, password: JSON.parse(l.envelope), lastTestedAt: l.last_tested_at, lastResult: l.last_result }])),
  });
  const profile = (id: string) => { const r = one('SELECT * FROM profiles WHERE id = ?', id); return r ? toProfile(r) : null; };
  const putLogin = (k: Buffer, id: string, site: string, c: LoginRef, password: string, clearTest = false) =>
    run(`INSERT INTO logins (profile, site, url, username, envelope, key_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (profile, site) DO UPDATE SET url = excluded.url, username = excluded.username, envelope = excluded.envelope, key_id = excluded.key_id
      ${clearTest ? ', last_tested_at = NULL, last_result = NULL' : ''}`,
      id, site, c.url, c.username, JSON.stringify(encryptLogin(k, id, site, c, password)), keyId(k));
  const hAad = (id: string, origin: string, name: string) => ({ header: [id, origin, name] }); // an object: never a login's AAD
  const putHeader = (k: Buffer, id: string, origin: string, name: string, value: string) =>
    run(`INSERT INTO profile_headers (profile, origin, name, envelope, key_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (profile, origin, name) DO UPDATE SET envelope = excluded.envelope, key_id = excluded.key_id`,
      id, origin, name, JSON.stringify(seal(k, hAad(id, origin, name), value)), keyId(k));
  /** Decrypted headers of one origin, {} when none. */
  const headerValues = (id: string, origin: string) => Object.fromEntries(
    all('SELECT name, envelope FROM profile_headers WHERE profile = ? AND origin = ? ORDER BY name', id, origin)
      .map((h) => [h.name, unseal(key, hAad(id, origin, h.name), JSON.parse(h.envelope))]));

  return {
    profile,
    profiles: () => all('SELECT * FROM profiles ORDER BY created_at, id').map(toProfile),
    accessible: (userId: string) => all(`SELECT p.*, m.role FROM profile_members m JOIN profiles p ON p.id = m.profile
      WHERE m.user_id = ? ORDER BY p.created_at, p.id`, userId).map((r) => ({ ...toProfile(r), role: r.role as Role })),
    roleOf: (id: string, userId: string): Role | null =>
      one('SELECT role FROM profile_members WHERE profile = ? AND user_id = ?', id, userId)?.role ?? null,
    members: (id: string) => all(`SELECT u.email, m.role FROM profile_members m JOIN user u ON u.id = m.user_id
      WHERE m.profile = ? ORDER BY u.email`, id) as { email: string; role: Role }[],
    createProfile: (id: ProfileId, allow: string[], userId: string | null = null) => tx(db, () => {
      run('INSERT INTO profiles (id, allow_json, created_at) VALUES (?, ?, ?)', id, JSON.stringify(allow), Date.now());
      if (userId !== null) run("INSERT INTO profile_members VALUES (?, ?, 'admin')", id, userId);
      else if (!run("INSERT INTO profile_members SELECT ?, user_id, 'admin' FROM admins JOIN user ON user.id = admins.user_id WHERE email NOT IN pending_emails", id).changes)
        throw Error('No gateway admin');
    }),
    setRole: (id: ProfileId, userId: string, role: Role | null) => tx(db, () => {
      if (role !== 'admin' && !one("SELECT 1 FROM profile_members JOIN user ON user.id = user_id WHERE profile = ? AND role = 'admin' AND user_id <> ? AND email NOT IN pending_emails", id, userId))
        return false;
      if (role === null) run('DELETE FROM profile_members WHERE profile = ? AND user_id = ?', id, userId);
      else run(`INSERT INTO profile_members VALUES (?, ?, ?)
        ON CONFLICT (profile, user_id) DO UPDATE SET role = excluded.role`, id, userId, role);
      return true;
    }),
    setAllow: (id: ProfileId, allow: string[]) => run('UPDATE profiles SET allow_json = ? WHERE id = ?', JSON.stringify(allow), id),
    /** Logins, leases, handoffs and playbooks go with it (ON DELETE CASCADE), and so do the OAuth grants and API keys scoped to it:
     *  a later profile with the same id must not inherit them. */
    deleteProfile: (id: ProfileId) => tx(db, () => {
      const ref = 'profile:' + id;
      for (const t of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) run(`DELETE FROM ${t} WHERE referenceId = ?`, ref);
      run("DELETE FROM apikey WHERE json_extract(metadata, '$.scope') = ?", ref);
      // Authorization codes not yet exchanged: a profile recreated under the same id must not inherit them.
      run("DELETE FROM verification WHERE json_valid(value) AND json_extract(value, '$.referenceId') = ?", ref);
      run('DELETE FROM profiles WHERE id = ?', id);
    }),

    /** A new URL, username or password makes the last test result meaningless: cleared. */
    saveLogin: (id: ProfileId, site: string, c: LoginRef, password: string) => putLogin(key, id, site, c, password, true),
    setLoginTest: (id: ProfileId, site: string, ok: boolean) =>
      run('UPDATE logins SET last_tested_at = ?, last_result = ? WHERE profile = ? AND site = ?', Date.now(), ok ? 'ok' : 'fail', id, site),
    deleteLogin: (id: ProfileId, site: string) => run('DELETE FROM logins WHERE profile = ? AND site = ?', id, site),
    decryptLogin: (id: string, site: string, c: Login) => decryptLogin(key, id, site, c),

    /** Names only, never values. */
    headers: (id: string) => all('SELECT origin, name FROM profile_headers WHERE profile = ? ORDER BY origin, name', id) as { origin: string; name: string }[],
    headerValues,
    /** Throws on a bad header, or when the origin's headers would no longer fit in one agent-browser argument. */
    saveHeader(id: ProfileId, allow: readonly string[], rawOrigin: string, name: string, value: string) {
      const origin = headerOrigin(rawOrigin), bad = badHeader(origin, name, value, allow);
      if (bad) throw Error(bad);
      const n = name.toLowerCase();
      if (JSON.stringify({ ...headerValues(id, origin!), [n]: value }).length > HEADERS_MAX) throw Error(`Headers of ${origin} are over ${HEADERS_MAX} characters`);
      putHeader(key, id, origin!, n, value);
      return { origin: origin!, name: n };
    },
    deleteHeader: (id: ProfileId, origin: string, name: string) =>
      Number(run('DELETE FROM profile_headers WHERE profile = ? AND origin = ? AND name = ?', id, origin, String(name).toLowerCase()).changes) > 0,

    /** Re-encrypts every login and header with newKey in one transaction (any failure = nothing changed). The store then uses newKey. */
    rotateLoginKey(newKey: Buffer) {
      const n = tx(db, () => {
        const rows = all('SELECT profile, site, url, username, envelope FROM logins');
        for (const l of rows) {
          const c = { url: l.url, username: l.username, password: JSON.parse(l.envelope) };
          putLogin(newKey, l.profile, l.site, c, decryptLogin(key, l.profile, l.site, c));
        }
        const hs = all('SELECT profile, origin, name, envelope FROM profile_headers');
        for (const h of hs) putHeader(newKey, h.profile, h.origin, h.name, unseal(key, hAad(h.profile, h.origin, h.name), JSON.parse(h.envelope)));
        return rows.length + hs.length;
      });
      key = newKey; kid = keyId(newKey);
      return n;
    },
    keyId: () => kid,

    playbooks: (id: string) => all('SELECT name, body, updated FROM playbooks WHERE profile = ? ORDER BY name', id) as Playbook[],
    playbook: (id: string, name: string) => one('SELECT name, body, updated FROM playbooks WHERE profile = ? AND name = ?', id, name) as Playbook | undefined,
    /** Throws on a bad name or body. */
    savePlaybook(id: ProfileId, name: string, body: string): 'created' | 'updated' {
      const bad = badPlaybook(name, body);
      if (bad) throw Error(bad);
      // ponytail: no tx, synchronous calls on one connection cannot interleave
      const had = !!one('SELECT 1 FROM playbooks WHERE profile = ? AND name = ?', id, name);
      run(`INSERT INTO playbooks (profile, name, body, updated) VALUES (?, ?, ?, ?)
        ON CONFLICT (profile, name) DO UPDATE SET body = excluded.body, updated = excluded.updated`, id, name, body, Date.now());
      return had ? 'updated' : 'created';
    },
    deletePlaybook: (id: ProfileId, name: string) => Number(run('DELETE FROM playbooks WHERE profile = ? AND name = ?', id, name).changes) > 0,
  };
}
