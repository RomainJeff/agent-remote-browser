// Saved-login envelopes (AES-256-GCM, AAD = profile/site/url/username) and the key file rules.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadLoginKey, encryptLogin, decryptLogin } from '../../src/store/logins-crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'arb-crypto-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const login = { url: 'https://example.com/login', username: 'fixture' };
const secret = () => randomBytes(16).toString('hex');
const key = randomBytes(32);

test('key file created 0600, 32 bytes, read back unchanged', () => {
  const f = join(dir, 'new.key'), k = loadLoginKey(f, false);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(k.length, 32);
  assert.deepEqual(loadLoginKey(f, true), k);
});

test('missing key with envelopes: refuse, never create one', () => {
  assert.throws(() => loadLoginKey(join(dir, 'absent.key'), true), /Restore the existing login key/);
  assert.throws(() => readFileSync(join(dir, 'absent.key')));
});

test('missing key on a path that cannot be written: clear error', () => {
  assert.throws(() => loadLoginKey(join(dir, 'no', 'such', 'dir', 'k'), false), /cannot be created there/);
});

test('key of the wrong size is refused', () => {
  writeFileSync(join(dir, 'short.key'), randomBytes(16));
  assert.throws(() => loadLoginKey(join(dir, 'short.key'), false), /Invalid login key/);
});

test('round trip, password absent from the envelope', () => {
  const pw = secret(), env = encryptLogin(key, 'p1', 'site', login, pw);
  assert.deepEqual(Object.keys(env).sort(), ['data', 'iv', 'tag']);
  assert.ok(!JSON.stringify(env).includes(pw));
  assert.equal(decryptLogin(key, 'p1', 'site', { ...login, password: env }), pw);
});

test('tampered tag, data or iv fails', () => {
  const env = encryptLogin(key, 'p1', 'site', login, secret());
  const flip = (b64: string) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  for (const field of ['tag', 'data', 'iv'] as const)
    assert.throws(() => decryptLogin(key, 'p1', 'site', { ...login, password: { ...env, [field]: flip(env[field]) } }), field);
});

test('envelope is bound to profile, site, url and username', () => {
  const password = encryptLogin(key, 'p1', 'site', login, secret());
  assert.throws(() => decryptLogin(key, 'p2', 'site', { ...login, password }));
  assert.throws(() => decryptLogin(key, 'p1', 'other', { ...login, password }));
  assert.throws(() => decryptLogin(key, 'p1', 'site', { ...login, url: 'https://example.com/evil', password }));
  assert.throws(() => decryptLogin(key, 'p1', 'site', { ...login, username: 'someone', password }));
});

test('another key cannot decrypt', () => {
  const password = encryptLogin(key, 'p1', 'site', login, secret());
  assert.throws(() => decryptLogin(randomBytes(32), 'p1', 'site', { ...login, password }));
});
