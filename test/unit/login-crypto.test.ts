// Saved-login envelopes (AES-256-GCM, AAD = profile/site/url/username). store.mjs reads its env at import time,
// so each scenario imports a fresh module instance (query string) after setting STATE_FILE and LOGIN_KEY_FILE.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const scratch = mkdtempSync(join(tmpdir(), 'arb-crypto-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
async function freshStore(state?: object, key?: Buffer) {
  const dir = join(scratch, String(++n));
  rmSync(dir, { recursive: true, force: true });
  (await import('node:fs')).mkdirSync(dir);
  process.env.STATE_FILE = join(dir, 'state.json');
  process.env.LOGIN_KEY_FILE = join(dir, 'login.key');
  if (state) writeFileSync(process.env.STATE_FILE, JSON.stringify(state));
  if (key) writeFileSync(process.env.LOGIN_KEY_FILE, key);
  return { dir, store: await import(new URL(`../../store.mjs?${n}`, import.meta.url).href) };
}

const login = { url: 'https://example.com/login', username: 'fixture' };
const secret = () => randomBytes(16).toString('hex');

test('round trip, key file created 0600', async () => {
  const { store } = await freshStore();
  const pw = secret();
  const env = store.encryptLogin('p1', 'site', login, pw);
  assert.deepEqual(Object.keys(env).sort(), ['data', 'iv', 'tag']);
  assert.ok(!JSON.stringify(env).includes(pw));
  assert.equal(store.decryptLogin('p1', 'site', { ...login, password: env }), pw);
  assert.equal(statSync(process.env.LOGIN_KEY_FILE!).mode & 0o777, 0o600);
  assert.equal(readFileSync(process.env.LOGIN_KEY_FILE!).length, 32);
});

test('tampered tag, data or iv fails', async () => {
  const { store } = await freshStore();
  const env = store.encryptLogin('p1', 'site', login, secret());
  const flip = (b64: string) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  for (const field of ['tag', 'data', 'iv'] as const)
    assert.throws(() => store.decryptLogin('p1', 'site', { ...login, password: { ...env, [field]: flip(env[field]) } }), field);
});

test('envelope is bound to profile, site, url and username', async () => {
  const { store } = await freshStore();
  const password = store.encryptLogin('p1', 'site', login, secret());
  assert.throws(() => store.decryptLogin('p2', 'site', { ...login, password }));
  assert.throws(() => store.decryptLogin('p1', 'other', { ...login, password }));
  assert.throws(() => store.decryptLogin('p1', 'site', { ...login, url: 'https://example.com/evil', password }));
  assert.throws(() => store.decryptLogin('p1', 'site', { ...login, username: 'someone', password }));
});

test('another key cannot decrypt', async () => {
  const a = (await freshStore()).store, b = (await freshStore()).store;
  const password = a.encryptLogin('p1', 'site', login, secret());
  assert.throws(() => b.decryptLogin('p1', 'site', { ...login, password }));
});

test('legacy plaintext logins are encrypted on load, state file 0600', async () => {
  // Empty password: exercises the legacy representation without writing a credential.
  await freshStore({ profiles: { fixture: { logins: { site: { ...login, password: '' } } } } });
  const saved = JSON.parse(readFileSync(process.env.STATE_FILE!, 'utf8')).profiles.fixture.logins.site;
  assert.equal(typeof saved.password, 'object');
  assert.equal(statSync(process.env.STATE_FILE!).mode & 0o777, 0o600);
  const { store } = await freshStore(undefined, readFileSync(process.env.LOGIN_KEY_FILE!));
  assert.equal(store.decryptLogin('fixture', 'site', saved), '');
});

test('encrypted logins without their key: refuse to start, never create a new key', async () => {
  const { store, dir } = await freshStore();
  const state = { profiles: { fixture: { logins: { site: { ...login, password: store.encryptLogin('fixture', 'site', login, secret()) } } } } };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  unlinkSync(join(dir, 'login.key'));
  process.env.STATE_FILE = join(dir, 'state.json');
  process.env.LOGIN_KEY_FILE = join(dir, 'login.key');
  await assert.rejects(import(new URL('../../store.mjs?missing-key', import.meta.url).href), /Restore the existing login key/);
  assert.equal(existsSync(join(dir, 'login.key')), false);
});

test('wrong key with encrypted logins fails before rewriting state', async () => {
  const { store, dir } = await freshStore();
  const state = { profiles: { fixture: { logins: { site: { ...login, password: store.encryptLogin('fixture', 'site', login, secret()) } } } } };
  const raw = JSON.stringify(state);
  writeFileSync(join(dir, 'state.json'), raw);
  writeFileSync(join(dir, 'login.key'), randomBytes(32));
  await assert.rejects(import(new URL('../../store.mjs?wrong-key', import.meta.url).href));
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), raw);
});

test('key of the wrong size is refused', async () => {
  await assert.rejects(freshStore(undefined, randomBytes(16)), /Invalid login key/);
});
