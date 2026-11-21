// Saved-login envelopes (AES-256-GCM, AAD = profile/site/url/username), through openStore().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../../src/store/state.ts';

const scratch = mkdtempSync(join(tmpdir(), 'arb-crypto-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function freshStore(state?: object, key?: Buffer) {
  const dir = join(scratch, String(++n));
  mkdirSync(dir);
  const file = join(dir, 'state.json'), keyFile = join(dir, 'login.key');
  if (state) writeFileSync(file, JSON.stringify(state));
  if (key) writeFileSync(keyFile, key);
  return { dir, file, keyFile, store: openStore(file, keyFile) };
}

const login = { url: 'https://example.com/login', username: 'fixture' };
const secret = () => randomBytes(16).toString('hex');

test('round trip, key file created 0600', () => {
  const { store, keyFile } = freshStore();
  const pw = secret();
  const env = store.encryptLogin('p1', 'site', login, pw);
  assert.deepEqual(Object.keys(env).sort(), ['data', 'iv', 'tag']);
  assert.ok(!JSON.stringify(env).includes(pw));
  assert.equal(store.decryptLogin('p1', 'site', { ...login, password: env }), pw);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(keyFile).length, 32);
});

test('tampered tag, data or iv fails', () => {
  const { store } = freshStore();
  const env = store.encryptLogin('p1', 'site', login, secret());
  const flip = (b64: string) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  for (const field of ['tag', 'data', 'iv'] as const)
    assert.throws(() => store.decryptLogin('p1', 'site', { ...login, password: { ...env, [field]: flip(env[field]) } }), field);
});

test('envelope is bound to profile, site, url and username', () => {
  const { store } = freshStore();
  const password = store.encryptLogin('p1', 'site', login, secret());
  assert.throws(() => store.decryptLogin('p2', 'site', { ...login, password }));
  assert.throws(() => store.decryptLogin('p1', 'other', { ...login, password }));
  assert.throws(() => store.decryptLogin('p1', 'site', { ...login, url: 'https://example.com/evil', password }));
  assert.throws(() => store.decryptLogin('p1', 'site', { ...login, username: 'someone', password }));
});

test('another key cannot decrypt', () => {
  const a = (freshStore()).store, b = (freshStore()).store;
  const password = a.encryptLogin('p1', 'site', login, secret());
  assert.throws(() => b.decryptLogin('p1', 'site', { ...login, password }));
});

test('legacy plaintext logins are encrypted on load, state file 0600', () => {
  // Empty password: exercises the legacy representation without writing a credential.
  const { file, keyFile } = freshStore({ profiles: { fixture: { logins: { site: { ...login, password: '' } } } } });
  const saved = JSON.parse(readFileSync(file, 'utf8')).profiles.fixture.logins.site;
  assert.equal(typeof saved.password, 'object');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const { store } = freshStore(undefined, readFileSync(keyFile));
  assert.equal(store.decryptLogin('fixture', 'site', saved), '');
});

test('encrypted logins without their key: refuse to start, never create a new key', () => {
  const { store, dir } = freshStore();
  const state = { profiles: { fixture: { logins: { site: { ...login, password: store.encryptLogin('fixture', 'site', login, secret()) } } } } };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  unlinkSync(join(dir, 'login.key'));
  assert.throws(() => openStore(join(dir, 'state.json'), join(dir, 'login.key')), /Restore the existing login key/);
  assert.equal(existsSync(join(dir, 'login.key')), false);
});

test('wrong key with encrypted logins fails before rewriting state', () => {
  const { store, dir } = freshStore();
  const state = { profiles: { fixture: { logins: { site: { ...login, password: store.encryptLogin('fixture', 'site', login, secret()) } } } } };
  const raw = JSON.stringify(state);
  writeFileSync(join(dir, 'state.json'), raw);
  writeFileSync(join(dir, 'login.key'), randomBytes(32));
  assert.throws(() => openStore(join(dir, 'state.json'), join(dir, 'login.key')));
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), raw);
});

test('key of the wrong size is refused', () => {
  assert.throws(() => freshStore(undefined, randomBytes(16)), /Invalid login key/);
});
