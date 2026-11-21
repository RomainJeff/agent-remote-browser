// Operator CLI: rotate-login-key and migrate-from-poc, on a synthetic POC state and keys generated here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { main } from '../../src/cli.ts';
import { openDb } from '../../src/store/db.ts';
import { openStore } from '../../src/store/store.ts';
import { encryptLogin } from '../../src/store/logins-crypto.ts';
import { hash, parseProfileId } from '../../src/policy.ts';

const scratch = mkdtempSync(join(tmpdir(), 'arb-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function fresh() {
  const dir = join(scratch, String(++n));
  mkdirSync(dir);
  const env = { DATA_DIR: join(dir, 'data'), LOGIN_KEY_FILE: join(dir, 'login.key'), ALLOW_NO_SANDBOX: '1' };
  const lines: string[] = [];
  const run = (args: string[], docker?: Parameters<typeof main>[3]) => main(args, env, (l) => lines.push(l), docker);
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
  t.withStore((s) => { s.createProfile(parseProfileId('shop')!, ['example.com'], null); s.saveLogin(parseProfileId('shop')!, 'main', login, pw); });
  const oldKey = readFileSync(t.env.LOGIN_KEY_FILE);
  assert.equal(await t.run(['rotate-login-key']), 0);
  const newKey = readFileSync(t.env.LOGIN_KEY_FILE);
  assert.notDeepEqual(newKey, oldKey);
  assert.deepEqual(readFileSync(t.env.LOGIN_KEY_FILE + '.old'), oldKey);
  assert.equal(existsSync(t.env.LOGIN_KEY_FILE + '.new'), false);
  assert.match(t.lines[0], /^Re-encrypted 1 login\(s\): key [0-9a-f]{16} -> [0-9a-f]{16}\.$/);
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

/** A POC state.json as the POC writes it: one encrypted login, one legacy plaintext login, tokens, OAuth data. */
function pocFixture(dir: string) {
  const key = randomBytes(32), pw = { a: randomBytes(12).toString('hex'), b: randomBytes(12).toString('hex') };
  const tokens = ['acp_' + randomBytes(32).toString('base64url'), 'acg_' + randomBytes(32).toString('base64url')];
  const state = {
    profiles: {
      shop: { allow: ['example.com'], tokenHash: hash(tokens[0]), createdAt: 1_700_000_000_000,
        logins: { main: { ...login, password: encryptLogin(key, 'shop', 'main', login, pw.a) } } },
      news: { allow: ['example.org'], tokenHash: null, createdAt: 1_700_000_000_001,
        logins: { legacy: { url: 'https://example.org/', username: 'u', password: pw.b } } },
    },
    globalTokenHash: hash(tokens[1]),
    clients: { acc_x: { redirect_uris: ['https://example.com/cb'], client_name: 'x', createdAt: 1 } },
    tokens: { [hash('aca_x')]: { kind: 'access', principal: { global: true }, client: 'acc_x', exp: Date.now() + 60_000 } },
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'poc.key'), key);
  return { state: join(dir, 'state.json'), key: join(dir, 'poc.key'), secrets: [key, pw.a, pw.b, ...tokens], pw };
}
const fakeDocker = () => {
  const copies: [string, string][] = [];
  return { copies, copyVolume: async (from: string, id: string) => { copies.push([from, id]); return 'copied' as const; } };
};

test('migrate-from-poc dry run: verifies everything, writes nothing, prints the docker commands', async () => {
  const t = fresh(), poc = pocFixture(t.dir), docker = fakeDocker();
  assert.equal(await t.run(['migrate-from-poc', poc.state, poc.key], docker), 0);
  assert.deepEqual(docker.copies, []);
  assert.match(t.lines[0], /^Would import 2 profile\(s\), 2 login\(s\)/);
  assert.ok(t.lines.includes('docker run --rm --network none -v ac-profile-shop:/from:ro -v arb-profile-shop:/to alpine:3.22 cp -a /from/. /to/'));
  assert.ok(t.lines.includes('docker volume create --label arb-computer=news arb-profile-news'));
  assert.equal(t.withStore((s) => s.profiles().length), 0);
  assertNoSecret(t.lines, poc.secrets);
});

test('migrate-from-poc --apply: profiles, allowlists, re-encrypted logins; no token or OAuth data; volumes copied', async () => {
  const t = fresh(), poc = pocFixture(t.dir), docker = fakeDocker();
  assert.equal(await t.run(['migrate-from-poc', poc.state, poc.key, '--apply'], docker), 0);
  assert.deepEqual(docker.copies, [['ac-profile-shop', 'shop'], ['ac-profile-news', 'news']]);
  t.withStore((s) => {
    assert.deepEqual(s.profiles().map((p) => [p.id, p.allow, p.tokenHash, p.createdAt]),
      [['shop', ['example.com'], null, 1_700_000_000_000], ['news', ['example.org'], null, 1_700_000_000_001]]);
    assert.equal(s.decryptLogin('shop', 'main', s.profile('shop')!.logins.main), poc.pw.a);
    assert.equal(s.decryptLogin('news', 'legacy', s.profile('news')!.logins.legacy), poc.pw.b);
    assert.equal(s.globalTokenHash(), null);
    assert.equal(s.clientCount(), 0);
    assert.equal(s.principalFor('aca_x'), null);
  });
  assertNoSecret(t.lines, poc.secrets);
  assertNoSecret(t.lines, [readFileSync(t.env.LOGIN_KEY_FILE)]);

  // Re-run: existing profiles left alone, the copier reports what it finds.
  t.lines.length = 0;
  assert.equal(await t.run(['migrate-from-poc', poc.state, poc.key, '--apply'], docker), 0);
  assert.match(t.lines[0], /^Imported 0 profile\(s\)/);
  assert.ok(t.lines.includes('Already in arb.db, left untouched: shop, news'));
});

test('migrate-from-poc with the wrong POC key: refused, nothing imported', async () => {
  const t = fresh(), poc = pocFixture(t.dir), docker = fakeDocker();
  writeFileSync(poc.key, randomBytes(32));
  await assert.rejects(t.run(['migrate-from-poc', poc.state, poc.key, '--apply'], docker));
  assert.deepEqual(docker.copies, []);
  assert.equal(t.withStore((s) => s.profiles().length), 0);
});

test('migrate-from-poc: a volume copy failure is reported, exit code 1', async () => {
  const t = fresh(), poc = pocFixture(t.dir);
  const docker = { copyVolume: async () => { throw Error('Docker API POST /containers/x/start: 500'); } };
  assert.equal(await t.run(['migrate-from-poc', poc.state, poc.key, '--apply'], docker), 1);
  assert.ok(t.lines.includes('ac-profile-shop -> arb-profile-shop: failed (Docker API POST /containers/x/start: 500)'));
});

test('unknown command prints usage, exit code 2', async () => {
  const t = fresh();
  assert.equal(await t.run(['frobnicate']), 2);
  assert.match(t.lines[0], /^Usage:/);
});
