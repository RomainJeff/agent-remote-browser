// SQLite store: migrations, repositories, login key rules, persisted leases. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../../src/store/db.ts';
import { openStore, describe } from '../../src/store/store.ts';
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
/** NNN of the last migration file. */
const LATEST = Number(readdirSync(new URL('../../src/store/migrations/', import.meta.url)).sort().at(-1)!.slice(0, 3));
const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as any).user_version;

test('migrations: empty db gets every table, WAL, foreign keys; re-running is a no-op', () => {
  const f = fresh(), db = openDb(f.db);
  assert.deepEqual(tables(db), [...BA, 'handoffs', 'leases', 'logins', 'playbooks', 'profile_headers', 'profiles', 'step_up'].sort());
  assert.equal(version(db), LATEST);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1);
  migrate(db);
  db.close();
  const again = openDb(f.db);
  assert.equal(version(again), LATEST);
  assert.equal(tables(again).length, BA.length + 7);
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
  assert.equal(version(db), LATEST);
  assert.deepEqual(tables(db), [...BA, 'handoffs', 'leases', 'logins', 'playbooks', 'profile_headers', 'profiles', 'step_up'].sort());
  assert.deepEqual(db.prepare('SELECT * FROM profiles').all().map((r) => ({ ...r })), [{ id: 'shop', allow_json: '["example.com"]', created_at: 1 }]);
  for (const t of ['logins', 'leases']) assert.equal((db.prepare(`SELECT count(*) n FROM ${t}`).get() as any).n, 1, t);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('playbooks: CRUD per profile, limits, gone with the profile', () => {
  const f = fresh(), db = openDb(f.db), s = openStore(db, f.key);
  s.createProfile(pid('shop'), []);
  s.createProfile(pid('other'), []);
  assert.equal(s.savePlaybook(pid('shop'), 'check-quota', '# Check quota\nsteps'), 'created');
  assert.equal(s.savePlaybook(pid('shop'), 'check-quota', '## Check the quota\nv2'), 'updated');
  s.savePlaybook(pid('shop'), 'a-first', '\n\n  First line  \nrest');
  s.savePlaybook(pid('other'), 'mine', 'x');
  assert.deepEqual(s.playbooks('shop').map((p) => p.name), ['a-first', 'check-quota']);
  assert.equal(s.playbook('shop', 'check-quota')!.body, '## Check the quota\nv2');
  assert.equal(s.playbook('shop', 'mine'), undefined, 'per profile');
  assert.equal(describe(s.playbook('shop', 'check-quota')!.body), 'Check the quota');
  assert.equal(describe(s.playbook('shop', 'a-first')!.body), 'First line');

  assert.throws(() => s.savePlaybook(pid('shop'), 'Bad Name', 'x'), /Name/);
  assert.throws(() => s.savePlaybook(pid('shop'), 'x'.repeat(41), 'x'), /Name/);
  assert.throws(() => s.savePlaybook(pid('shop'), 'blank', '  \n '), /required/);
  s.savePlaybook(pid('shop'), 'big', 'é'.repeat(10 * 1024));                          // 20 KB in bytes: fits
  assert.throws(() => s.savePlaybook(pid('shop'), 'big', 'é'.repeat(10 * 1024) + 'x'), /20 KB/);
  assert.throws(() => db.prepare("INSERT INTO playbooks VALUES ('shop', 'raw', ?, 1)").run('x'.repeat(20481)), /CHECK/);

  assert.equal(s.deletePlaybook(pid('shop'), 'a-first'), true);
  assert.equal(s.deletePlaybook(pid('shop'), 'a-first'), false);
  s.deleteProfile(pid('shop'));
  assert.deepEqual(s.playbooks('shop'), []);
  assert.deepEqual(s.playbooks('other').map((p) => p.name), ['mine']);
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

test('custom headers: per https origin on the allowlist, name lowercased, value sealed, cascade on delete', () => {
  const f = fresh(), db = openDb(f.db), s = openStore(db, f.key), id = pid('shop'), allow = ['example.com'];
  const secret = randomBytes(8).toString('hex');
  s.createProfile(id, allow);
  assert.deepEqual(s.saveHeader(id, allow, 'https://example.com/', 'X-Bypass', secret), { origin: 'https://example.com', name: 'x-bypass' });
  s.saveHeader(id, allow, 'https://example.com', 'x-bypass', secret + '2');
  assert.deepEqual(s.headers('shop').map((h) => ({ ...h })), [{ origin: 'https://example.com', name: 'x-bypass' }], 'replaced, not duplicated');
  assert.deepEqual(s.headerValues('shop', 'https://example.com'), { 'x-bypass': secret + '2' });
  assert.deepEqual(s.headerValues('shop', 'https://other.example.com'), {});
  const row = db.prepare('SELECT envelope, key_id FROM profile_headers').get() as any;
  assert.ok(!row.envelope.includes(secret));
  assert.equal(row.key_id, keyId(readFileSync(f.key)));
  for (const [origin, name, value, err] of [
    ['http://example.com', 'x-a', 'v', /Origin/], ['https://example.com/path', 'x-a', 'v', /Origin/],
    ['https://example.org', 'x-a', 'v', /Origin/], ['https://example.com', 'Host', 'v', /set by the browser/],
    ['https://example.com', 'proxy-authorization', 'v', /set by the browser/], ['https://example.com', 'bad name', 'v', /Name/],
    ['https://example.com', 'x-a', 'line\nbreak', /Value/], ['https://example.com', 'x-a', ' padded', /Value/],
    ['https://example.com', 'x-a', 'x'.repeat(2001), /Value/], ['https://example.com', 'x-a', 'x'.repeat(1970), null],
    ['https://example.com', 'x-b', 'x'.repeat(1970), null], ['https://example.com', 'x-c', 'x'.repeat(100), /over 4000/],
  ] as [string, string, string, RegExp | null][]) {
    if (err) assert.throws(() => s.saveHeader(id, allow, origin, name, value), err, `${origin} ${name}`);
    else s.saveHeader(id, allow, origin, name, value);
  }
  assert.equal(s.deleteHeader(id, 'https://example.com', 'X-B'), true);
  assert.equal(s.deleteHeader(id, 'https://example.com', 'x-b'), false);
  s.deleteProfile(id);
  assert.equal((db.prepare('SELECT count(*) n FROM profile_headers').get() as any).n, 0);
  db.close();
});

test('saved headers alone also pin the login key; rotation re-encrypts them', () => {
  const f = fresh(), db = openDb(f.db), id = pid('p');
  openStore(db, f.key).createProfile(id, ['example.com']);
  openStore(db, f.key).saveHeader(id, ['example.com'], 'https://example.com', 'x-a', 'v1');
  const key = readFileSync(f.key);
  writeFileSync(f.key, randomBytes(32));
  assert.throws(() => openStore(db, f.key), /does not match saved logins or headers/);
  writeFileSync(f.key, key);
  const s = openStore(db, f.key), next = randomBytes(32);
  assert.equal(s.rotateLoginKey(next), 1);
  writeFileSync(f.key, next);
  assert.deepEqual(openStore(db, f.key).headerValues('p', 'https://example.com'), { 'x-a': 'v1' });
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
