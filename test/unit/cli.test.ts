// Operator CLI: rotate-login-key, backup-db and admin, on keys generated here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { main } from '../../src/cli.ts';
import { openDb } from '../../src/store/db.ts';
import { openStore } from '../../src/store/store.ts';
import { parseProfileId } from '../../src/policy.ts';
import { totp } from '../totp.ts';

const scratch = mkdtempSync(join(tmpdir(), 'arb-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function fresh() {
  const dir = join(scratch, String(++n));
  mkdirSync(dir);
  const env = { DATA_DIR: join(dir, 'data'), LOGIN_KEY_FILE: join(dir, 'login.key'), ALLOW_NO_SANDBOX: '1', BETTER_AUTH_SECRET: randomBytes(32).toString('hex') };
  const lines: string[] = [];
  const run = (args: string[], ask?: Parameters<typeof main>[3]) => main(args, env, (l) => lines.push(l), ask);
  const withStore = <T>(fn: (s: ReturnType<typeof openStore>) => T) => {
    const db = openDb(join(env.DATA_DIR, 'arb.db'));
    try { return fn(openStore(db, env.LOGIN_KEY_FILE)); } finally { db.close(); }
  };
  return { dir, env, lines, run, withStore };
}
/** Every textual form a secret could leak in. */
const forms = (b: Buffer | string) => typeof b === 'string' ? [b] : [b.toString('hex'), b.toString('base64'), b.toString('base64url'), b.toString('latin1')];
const assertNoSecret = (lines: string[], secrets: (Buffer | string)[]) => {
  const text = lines.join('\n');
  for (const s of secrets) for (const f of forms(s)) assert.ok(!text.includes(f), 'secret in CLI output');
};
const login = { url: 'https://example.com/login', username: 'fixture' };

test('rotate-login-key: every login re-encrypted, new key in place, old key kept', async () => {
  const t = fresh(), pw = randomBytes(12).toString('hex');
  t.withStore((s) => { s.createProfile(parseProfileId('shop')!, ['example.com']); s.saveLogin(parseProfileId('shop')!, 'main', login, pw); });
  const oldKey = readFileSync(t.env.LOGIN_KEY_FILE);
  assert.equal(await t.run(['rotate-login-key']), 0);
  const newKey = readFileSync(t.env.LOGIN_KEY_FILE);
  assert.notDeepEqual(newKey, oldKey);
  assert.deepEqual(readFileSync(t.env.LOGIN_KEY_FILE + '.old'), oldKey);
  assert.equal(existsSync(t.env.LOGIN_KEY_FILE + '.new'), false);
  assert.match(t.lines[0], /^Re-encrypted 1 login\(s\) and header\(s\): key [0-9a-f]{16} -> [0-9a-f]{16}\.$/);
  assert.equal(t.withStore((s) => s.decryptLogin('shop', 'main', s.profile('shop')!.logins.main)), pw);
  assertNoSecret(t.lines, [pw, oldKey, newKey]);
  // The old key no longer opens the database.
  renameSync(t.env.LOGIN_KEY_FILE + '.old', t.env.LOGIN_KEY_FILE);
  assert.throws(() => t.withStore(() => {}), /does not match saved logins/);
});

test('rotate-login-key refuses to clobber an earlier .old key', async () => {
  const t = fresh();
  t.withStore(() => {});
  writeFileSync(t.env.LOGIN_KEY_FILE + '.old', randomBytes(32));
  await assert.rejects(t.run(['rotate-login-key']), /exists \(earlier rotation\?\)/);
});

test('backup-db: consistent copy while the database is open and written, 0600, never overwrites', async () => {
  const t = fresh(), pw = randomBytes(12).toString('hex'), shop = parseProfileId('shop')!;
  t.withStore((s) => { s.createProfile(shop, ['example.com']); s.saveLogin(shop, 'main', login, pw); });
  // The gateway's connection: open, WAL mode, a commit still in the -wal file (no checkpoint yet).
  const live = openDb(join(t.env.DATA_DIR, 'arb.db'));
  live.exec('PRAGMA wal_autocheckpoint = 0');
  openStore(live, t.env.LOGIN_KEY_FILE).createProfile(parseProfileId('news')!, ['example.org']);
  const file = join(t.dir, 'backup.db');
  try {
    assert.equal(await t.run(['backup-db', file]), 0);
  } finally { live.close(); }
  assert.equal(t.lines.at(-1), `arb.db backed up to ${file}: 2 profile(s), 1 login(s), integrity ok.`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(file + '-wal'), false);
  // The copy opens as a data dir of its own, with the same key, and decrypts the login.
  const restored = join(t.dir, 'restored');
  mkdirSync(restored);
  renameSync(file, join(restored, 'arb.db'));
  const db = openDb(join(restored, 'arb.db'));
  try {
    const s = openStore(db, t.env.LOGIN_KEY_FILE);
    assert.ok(s.profile('news'));
    assert.equal(s.decryptLogin('shop', 'main', s.profile('shop')!.logins.main), pw);
  } finally { db.close(); }
  assertNoSecret(t.lines, [pw, readFileSync(t.env.LOGIN_KEY_FILE)]);
  writeFileSync(file, 'x');
  await assert.rejects(t.run(['backup-db', file]), /EEXIST/);
  assert.equal(readFileSync(file, 'utf8'), 'x');
});

/** Answers the CLI prompts like a person with an authenticator app: password, then the code for the printed URI. */
const asker = (t: ReturnType<typeof fresh>, password: string, code?: (uri: string) => string) => async (prompt: string) =>
  prompt.startsWith('Password') ? password : (code ?? totp)(t.lines.find((l) => l.startsWith('otpauth://'))!);
const backups = (lines: string[]) => lines.filter((l) => /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(l));
const count = (t: ReturnType<typeof fresh>, sql: string) => {
  const db = openDb(join(t.env.DATA_DIR, 'arb.db'));
  try { return (db.prepare(sql).get() as { n: number }).n; } finally { db.close(); }
};

test('admin create: only the TOTP URI and backup codes are printed; one admin per gateway; no session left', async () => {
  const t = fresh(), password = randomBytes(12).toString('base64url');
  assert.equal(await t.run(['admin', 'create', 'Admin@Example.test'], asker(t, password)), 0);
  const uri = t.lines.find((l) => l.startsWith('otpauth://totp/'))!;
  assert.match(uri, /secret=[A-Z2-7]+/);
  assertNoSecret(t.lines, [password, t.env.BETTER_AUTH_SECRET]);
  assert.equal(t.lines.at(-1), 'Admin admin@example.test ready: sign in with the password and a TOTP code.');
  assert.equal(count(t, 'SELECT count(*) n FROM user WHERE twoFactorEnabled = 1'), 1);
  assert.equal(count(t, 'SELECT count(*) n FROM session'), 0);
  const secret = new URL(uri).searchParams.get('secret')!;
  assert.equal(count(t, `SELECT count(*) n FROM twoFactor WHERE secret LIKE '%${secret}%'`), 0, 'TOTP secret encrypted at rest');
  const codes = backups(t.lines);
  assert.equal(codes.length, 10);
  assert.equal(count(t, `SELECT count(*) n FROM twoFactor WHERE backupCodes LIKE '%${codes[0]}%'`), 0, 'backup codes encrypted at rest');

  await assert.rejects(t.run(['admin', 'create', 'admin@example.test'], asker(t, password)), /exists: use admin reset-2fa/);
  await assert.rejects(t.run(['admin', 'create', 'other@example.test'], asker(t, password)), /one admin per gateway/);
  await assert.rejects(t.run(['admin', 'create', 'not-an-email'], asker(t, password)), /Invalid email/);
});

test('admin create: short password or wrong code refused', async () => {
  const t = fresh();
  await assert.rejects(t.run(['admin', 'create', 'a@example.test'], asker(t, 'short')), /12 to 128/);
  await assert.rejects(t.run(['admin', 'create', 'a@example.test'],
    asker(t, randomBytes(12).toString('base64url'), (u) => String((Number(totp(u)) + 1) % 1e6).padStart(6, '0'))), /Code rejected/);
  assert.equal(backups(t.lines).length, 0, 'no backup codes before the code checks out');
  assert.equal(count(t, 'SELECT count(*) n FROM user WHERE twoFactorEnabled = 1'), 0, 'not an admin until the code checks out');
});

test('admin reset-2fa: new password and TOTP secret, sessions dropped', async () => {
  const t = fresh(), first = randomBytes(12).toString('base64url'), second = randomBytes(12).toString('base64url');
  await assert.rejects(t.run(['admin', 'reset-2fa', 'a@example.test'], asker(t, first)), /No admin/);
  assert.equal(await t.run(['admin', 'create', 'a@example.test'], asker(t, first)), 0);
  const before = t.lines.find((l) => l.startsWith('otpauth://')), oldCodes = backups(t.lines);
  t.lines.length = 0;
  assert.equal(await t.run(['admin', 'reset-2fa', 'a@example.test'], asker(t, second)), 0);
  const after = t.lines.find((l) => l.startsWith('otpauth://'));
  assert.ok(after && after !== before, 'new TOTP secret');
  assert.equal(backups(t.lines).filter((c) => oldCodes.includes(c)).length, 0, 'new backup codes');
  assertNoSecret(t.lines, [first, second]);
  assert.equal(count(t, 'SELECT count(*) n FROM twoFactor'), 1);
  assert.equal(count(t, 'SELECT count(*) n FROM session'), 0);
});

test('unknown command prints usage, exit code 2', async () => {
  const t = fresh();
  assert.equal(await t.run(['frobnicate']), 2);
  assert.match(t.lines[0], /^Usage:/);
});

test('key create: profile-scoped key in a new 0600 file, never printed, works, expires, revocable', async () => {
  const t = fresh(), password = randomBytes(12).toString('base64url'), file = join(t.dir, 'key');
  t.withStore((s) => s.createProfile(parseProfileId('shop')!, ['example.com']));
  await assert.rejects(t.run(['key', 'create', 'shop', file]), /No admin yet/);
  assert.equal(existsSync(file), false);
  assert.equal(await t.run(['admin', 'create', 'a@example.test'], asker(t, password)), 0);
  await assert.rejects(t.run(['key', 'create', 'nope', file]), /No profile nope/);
  await assert.rejects(t.run(['key', 'create', 'shop', file, '400']), /Days: 1 to 365/);
  t.lines.length = 0;
  assert.equal(await t.run(['key', 'create', 'shop', file]), 0);
  const key = readFileSync(file, 'utf8');
  assert.match(key, /^arb_k_/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assertNoSecret(t.lines, [key]);
  const id = t.lines[0].match(/^Key (\S+) for profile shop, expires (\S+),/)!;
  assert.ok(Math.abs(Date.parse(id[2]) - Date.now() - 86400e3) < 60e3, 'one day by default');
  const db = openDb(join(t.env.DATA_DIR, 'arb.db'));
  try {
    const { createAuth, authOptions } = await import('../../src/auth/better-auth.ts');
    const { loadConfig } = await import('../../src/config.ts');
    const { auth } = createAuth(db, authOptions(loadConfig(t.env)));
    const v = await auth.api.verifyApiKey({ body: { key } });
    assert.equal(v.valid, true);
    assert.deepEqual(v.key?.metadata, { scope: 'profile:shop' });
  } finally { db.close(); }
  await assert.rejects(t.run(['key', 'create', 'shop', file]), /EEXIST/);
  assert.equal(await t.run(['key', 'revoke', id[1]]), 0);
  assert.equal(count(t, 'SELECT count(*) n FROM apikey'), 0);
  await assert.rejects(t.run(['key', 'revoke', id[1]]), /No key/);
  // --global: scope global, same file rules.
  rmSync(file); t.lines.length = 0;
  assert.equal(await t.run(['key', 'create', '--global', file]), 0);
  assert.match(t.lines[0], /^Key \S+ for all profiles \(global\), expires /);
  assertNoSecret(t.lines, [readFileSync(file, 'utf8')]);
  assert.equal(count(t, "SELECT count(*) n FROM apikey WHERE metadata LIKE '%\"global\"%'"), 1);
});
