// SQLite store: migrations, repositories, login key rules, persisted leases. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../../src/store/db.ts';
import { openStore } from '../../src/store/store.ts';
import { keyId } from '../../src/store/logins-crypto.ts';
import { createLeases } from '../../src/mcp/leases.ts';
import { hash, parseProfileId } from '../../src/policy.ts';

const scratch = mkdtempSync(join(tmpdir(), 'arb-store-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const dir = join(scratch, String(++n)); mkdirSync(dir); return { dir, db: join(dir, 'arb.db'), key: join(dir, 'login.key') }; };
const pid = (s: string) => parseProfileId(s)!;
const login = { url: 'https://example.com/login', username: 'fixture' };
const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

const BA = ['account', 'apikey', 'oauthAccessToken', 'oauthClient', 'oauthClientAssertion', 'oauthClientResource', 'oauthConsent',
  'oauthRefreshToken', 'oauthResource', 'rateLimit', 'session', 'twoFactor', 'user', 'verification'];
const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as any).user_version;

test('migrations: empty db gets every table, WAL, foreign keys; re-running is a no-op', () => {
  const f = fresh(), db = openDb(f.db);
  assert.deepEqual(tables(db), [...BA, 'leases', 'logins', 'profiles'].sort());
  assert.equal(version(db), 2);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1);
  migrate(db);
  db.close();
  const again = openDb(f.db);
  assert.equal(version(again), 2);
  assert.equal(tables(again).length, BA.length + 3);
  again.close();
});

test('migration 002 on a Lot 3 database: profiles and logins kept, static tokens and hand-rolled OAuth gone', () => {
  const f = fresh(), lot3 = new DatabaseSync(f.db);
  lot3.exec(readFileSync(new URL('../../src/store/migrations/001_app.sql', import.meta.url), 'utf8'));
  lot3.exec('PRAGMA user_version = 1');
  lot3.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?)').run('shop', '["example.com"]', hash('acp_synthetic'), 1);
  lot3.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, ?, ?)').run('shop', 'site', login.url, login.username, '{}', 'k');
  lot3.prepare('INSERT INTO leases VALUES (?, ?, ?, ?)').run(hash('acl_synthetic'), 'shop', Date.now() + 60_000, 60_000);
  lot3.prepare('INSERT INTO settings VALUES (?, ?)').run('global_token_hash', hash('g'));
  lot3.prepare('INSERT INTO oauth_clients (id, redirect_uris_json, created_at) VALUES (?, ?, ?)').run('c1', '[]', 1);
  lot3.prepare('INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, ?)').run(hash('t'), 'access', 'shop', 'c1', Date.now());
  lot3.close();

  const db = openDb(f.db);
  assert.equal(version(db), 2);
  assert.deepEqual(tables(db), [...BA, 'leases', 'logins', 'profiles'].sort());
  assert.deepEqual(db.prepare('SELECT * FROM profiles').all().map((r) => ({ ...r })), [{ id: 'shop', allow_json: '["example.com"]', created_at: 1 }]);
  for (const t of ['logins', 'leases']) assert.equal((db.prepare(`SELECT count(*) n FROM ${t}`).get() as any).n, 1, t);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('profiles and logins: CRUD, key_id per envelope, cascade on delete', () => {
  const f = fresh(), db = openDb(f.db), s = openStore(db, f.key);
  const pw = randomBytes(8).toString('hex');
  s.createProfile(pid('shop'), ['example.com']);
  s.setAllow(pid('shop'), ['example.com', 'example.org']);
  s.saveLogin(pid('shop'), 'site', login, pw);
  const p = s.profile('shop')!;
  assert.deepEqual(p.allow, ['example.com', 'example.org']);
  assert.deepEqual(Object.keys(p.logins), ['site']);
  assert.equal(s.decryptLogin('shop', 'site', p.logins.site), pw);
  const row = db.prepare('SELECT envelope, key_id FROM logins').get() as any;
  assert.equal(row.key_id, keyId(readFileSync(f.key)));
  assert.ok(!row.envelope.includes(pw));
  assert.equal(s.profile('nope'), null);
  createLeases(db).take('shop', 5);
  // OAuth grants and API keys scoped to the profile: covered end to end in test/integration/gateway.test.ts.
  s.deleteProfile(pid('shop'));
  for (const t of ['profiles', 'logins', 'leases']) assert.equal((db.prepare(`SELECT count(*) n FROM ${t}`).get() as any).n, 0, t);
  db.close();
});

test('saved logins without their key: refuse to start, never create a new key', () => {
  const f = fresh(), db = openDb(f.db);
  openStore(db, f.key).createProfile(pid('p'), []);
  openStore(db, f.key).saveLogin(pid('p'), 'site', login, 'x');
  rmSync(f.key);
  assert.throws(() => openStore(db, f.key), /Restore the existing login key/);
  assert.equal(existsSync(f.key), false);
  writeFileSync(f.key, randomBytes(32));
  assert.throws(() => openStore(db, f.key), /does not match saved logins/);
  db.close();
});

test('leases: take, slide on use, release, expire', () => {
  const f = fresh(), db = openDb(f.db), s = openStore(db, f.key), leases = createLeases(db);
  s.createProfile(pid('p'), []);
  const { token, exp } = leases.take('p', 1);
  assert.match(token, /^arb_l_/);
  assert.equal(leases.of('p')?.exp, exp);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM leases').all()).includes(token), 'only the hash is stored');
  assert.equal(leases.use(token)?.profile, 'p');
  assert.equal(leases.use('arb_l_wrong'), null);
  assert.equal(leases.release(token), true);
  assert.equal(leases.of('p'), null);
  leases.take('p', 1);
  db.prepare('UPDATE leases SET exp = 0').run();
  assert.equal(leases.of('p'), null);
  db.close();
});
