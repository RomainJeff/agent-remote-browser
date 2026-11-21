// Cloudflare Access JWT checks against a local RSA keypair (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessVerifier } from '../../src/auth/access-jwt.ts';

const aud = 'a'.repeat(64), team = 'example';
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const pair = await crypto.subtle.generateKey({ ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'k1' };
const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

async function jwt(claims: object = {}, head: object = {}) {
  const body = `${enc({ alg: 'RS256', kid: 'k1', ...head })}.${enc({ iss: `https://${team}.cloudflareaccess.com`, aud: [aud], email: 'Admin@Example.test', exp: now() + 60, ...claims })}`;
  return `${body}.${Buffer.from(await crypto.subtle.sign(ALG, pair.privateKey, Buffer.from(body))).toString('base64url')}`;
}

test('Access JWT: valid token gives the lowercased email; every bad claim, alg, key or signature gives null', async () => {
  let fetches = 0;
  const verify = createAccessVerifier({ aud, team }, async () => { fetches++; return [jwk]; });
  assert.equal(await verify(await jwt()), 'admin@example.test');
  assert.equal(await verify(await jwt({ aud })), 'admin@example.test', 'aud as a string');

  const good = await jwt();
  const [h, p, s] = good.split('.');
  const bad: [string, unknown][] = [
    ['wrong aud', await jwt({ aud: ['b'.repeat(64)] })],
    ['wrong iss', await jwt({ iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', await jwt({ exp: now() - 1 })],
    ['not yet valid', await jwt({ nbf: now() + 600 })],
    ['no email', await jwt({ email: undefined })],
    ['HS256', await jwt({}, { alg: 'HS256' })],
    ['none', `${enc({ alg: 'none', kid: 'k1' })}.${p}.`],
    ['unknown kid', await jwt({}, { kid: 'k2' })],
    ['tampered claims', `${h}.${enc({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), email: 'evil@example.test' })}.${s}`],
    ['tampered signature', `${h}.${p}.${s.slice(0, -4)}AAAA`],
    ['extra segment', `${good}.x`],
    ['garbage', 'not.a.jwt'],
    ['not a string', undefined],
  ];
  for (const [name, token] of bad) assert.equal(await verify(token), null, name);
  assert.equal(fetches, 1, 'JWKS cached');
});

test('Access JWT: a failed JWKS fetch is not cached', async () => {
  let calls = 0;
  const verify = createAccessVerifier({ aud, team }, async () => { if (calls++ === 0) throw Error('down'); return [jwk]; });
  assert.equal(await verify(await jwt()), null);
  assert.equal(await verify(await jwt()), 'admin@example.test');
});

test('Access JWT: an unknown kid refetches the JWKS at once (rotation), at most once a minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1e12 });
  let fetches = 0, keys = [jwk];
  const verify = createAccessVerifier({ aud, team }, async () => { fetches++; return keys; });
  const at = (s: number) => t.mock.timers.setTime(1e12 + s * 1000);
  const rotated = () => jwt({}, { kid: 'k2' }); // exp follows the mocked clock
  assert.equal(await verify(await rotated()), null);
  assert.equal(fetches, 1, 'first download, then no refetch within the minute');
  keys = [jwk, { ...jwk, kid: 'k2' }];
  at(61);
  assert.equal(await verify(await rotated()), 'admin@example.test', 'new key picked up without waiting for the hour');
  assert.equal(fetches, 2);
  for (const s of [61, 90, 122]) { at(s); assert.equal(await verify(await jwt({}, { kid: 'forged' })), null); }
  assert.equal(fetches, 3, 'forged kids: one refetch a minute');
});
