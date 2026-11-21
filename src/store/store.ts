// App state in SQLite, behind small typed functions: profiles and saved logins.
// Leases: mcp/leases.ts. Identity, OAuth and API keys: Better Auth (auth/), same database.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ProfileId } from '../policy.ts';
import { tx } from './db.ts';
import { loadLoginKey, keyId, encryptLogin, decryptLogin, type Envelope, type LoginRef } from './logins-crypto.ts';

export interface Login extends LoginRef { password: Envelope }
export interface Profile { id: ProfileId; allow: string[]; logins: Record<string, Login>; createdAt: number }

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
    id: r.id, allow: JSON.parse(r.allow_json), createdAt: r.created_at,
    logins: Object.fromEntries(all('SELECT site, url, username, envelope FROM logins WHERE profile = ? ORDER BY site', r.id)
      .map((l) => [l.site, { url: l.url, username: l.username, password: JSON.parse(l.envelope) }])),
  });
  const profile = (id: string) => { const r = one('SELECT * FROM profiles WHERE id = ?', id); return r ? toProfile(r) : null; };
  const putLogin = (k: Buffer, id: string, site: string, c: LoginRef, password: string) =>
    run(`INSERT INTO logins (profile, site, url, username, envelope, key_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (profile, site) DO UPDATE SET url = excluded.url, username = excluded.username, envelope = excluded.envelope, key_id = excluded.key_id`,
      id, site, c.url, c.username, JSON.stringify(encryptLogin(k, id, site, c, password)), keyId(k));

  return {
    profile,
    profiles: () => all('SELECT * FROM profiles ORDER BY created_at, id').map(toProfile),
    createProfile: (id: ProfileId, allow: string[], createdAt = Date.now()) =>
      run('INSERT INTO profiles (id, allow_json, created_at) VALUES (?, ?, ?)', id, JSON.stringify(allow), createdAt),
    setAllow: (id: ProfileId, allow: string[]) => run('UPDATE profiles SET allow_json = ? WHERE id = ?', JSON.stringify(allow), id),
    /** Logins and leases go with it (ON DELETE CASCADE), and so do the OAuth grants and API keys scoped to it:
     *  a later profile with the same id must not inherit them. */
    deleteProfile: (id: ProfileId) => tx(db, () => {
      const ref = 'profile:' + id;
      for (const t of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) run(`DELETE FROM ${t} WHERE referenceId = ?`, ref);
      run("DELETE FROM apikey WHERE json_extract(metadata, '$.scope') = ?", ref);
      // Authorization codes not yet exchanged: a profile recreated under the same id must not inherit them.
      run("DELETE FROM verification WHERE json_valid(value) AND json_extract(value, '$.referenceId') = ?", ref);
      run('DELETE FROM profiles WHERE id = ?', id);
    }),

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
  };
}
