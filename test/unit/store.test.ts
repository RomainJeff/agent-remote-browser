// SQLite store: migrations, repositories, login key rules, persisted leases. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
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

test('migrations: empty db gets every table, WAL, foreign keys; re-running is a no-op', () => {
  const f = fresh(), db = openDb(f.db);
  assert.deepEqual(tables(db), ['leases', 'logins', 'oauth_clients', 'oauth_tokens', 'profiles', 'settings']);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 1);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1);
  migrate(db);
  db.close();
  const again = openDb(f.db);
  assert.equal((again.prepare('PRAGMA user_version').get() as any).user_version, 1);
  assert.equal(tables(again).length, 6);
  again.close();
});

test('profiles and logins: CRUD, key_id per envelope, cascade on delete', () => {
  const f = fresh(), db = openDb(f.db), s = openStore(db, f.key);
  const pw = randomBytes(8).toString('hex');
  s.createProfile(pid('shop'), ['example.com'], hash('t'));
  s.setAllow(pid('shop'), ['example.com', 'example.org']);
  s.saveLogin(pid('shop'), 'site', login, pw);
  const p = s.profile('shop')!;
  assert.deepEqual(p.allow, ['example.com', 'example.org']);
  assert.deepEqual(Object.keys(p.logins), ['site']);
  assert.equal(s.decryptLogin('shop', 'site', p.logins.site), pw);
  const row = db.prepare('SELECT envelope, key_id FROM logins').get() as any;
  assert.equal(row.key_id, keyId(readFileSync(f.key)));
  assert.ok(!row.envelope.includes(pw));
  assert.deepEqual(s.principalForStatic('t'), { profile: 'shop' });
  s.setProfileToken(pid('shop'), hash('t2'));
  assert.equal(s.principalForStatic('t'), null);
  assert.equal(s.profile('nope'), null);
  createLeases(db).take('shop', 5);
  s.issueTokens({ profile: pid('shop') }, 'c1');
  s.deleteProfile(pid('shop'));
  for (const t of ['logins', 'leases', 'oauth_tokens']) assert.equal((db.prepare(`SELECT count(*) n FROM ${t}`).get() as any).n, 0, t);
  db.close();
});

test('settings, OAuth clients and tokens: global principal, refresh single use, revoke', () => {
  const f = fresh(), db = openDb(f.db), s = openStore(db, f.key);
  assert.equal(s.globalTokenHash(), null);
  s.setGlobalTokenHash(hash('g'));
  assert.deepEqual(s.principalFor('g'), { global: true });
  s.addClient('c1', { redirect_uris: ['https://example.com/cb'], client_name: 'x', secretHash: null });
  assert.deepEqual(s.client('c1')?.redirect_uris, ['https://example.com/cb']);
  assert.equal(s.clientCount(), 1);
  const t = s.issueTokens({ global: true }, 'c1');
  assert.deepEqual(s.principalFor(t.access_token), { global: true });
  assert.equal(s.principalFor(t.refresh_token), null, 'refresh token is not a bearer');
  assert.equal(s.takeRefresh(t.refresh_token, 'other'), null, 'bound to its client');
  assert.deepEqual(s.takeRefresh(t.refresh_token, 'c1'), { global: true });
  assert.equal(s.takeRefresh(t.refresh_token, 'c1'), null, 'single use');
  s.revokeTokens({ global: true });
  assert.equal(s.principalFor(t.access_token), null);
  db.close();
});

test('saved logins without their key: refuse to start, never create a new key', () => {
  const f = fresh(), db = openDb(f.db);
  openStore(db, f.key).createProfile(pid('p'), [], null);
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
  s.createProfile(pid('p'), [], null);
  const { token, exp } = leases.take('p', 1);
  assert.match(token, /^acl_/);
  assert.equal(leases.of('p')?.exp, exp);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM leases').all()).includes(token), 'only the hash is stored');
  assert.equal(leases.use(token)?.profile, 'p');
  assert.equal(leases.use('acl_wrong'), null);
  assert.equal(leases.release(token), true);
  assert.equal(leases.of('p'), null);
  leases.take('p', 1);
  db.prepare('UPDATE leases SET exp = 0').run();
  assert.equal(leases.of('p'), null);
  db.close();
});
