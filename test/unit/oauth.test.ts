// OAuth server edge cases in-process (no gateway, no Docker). The happy path through the real
// gateway lives in test/integration/gateway.test.ts. Budgets are per OAuth instance: each test gets
// a fresh one over the same store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openStore } from '../../src/store/state.ts';
import { hash } from '../../src/policy.ts';

const dir = mkdtempSync(join(tmpdir(), 'arb-oauth-'));
delete process.env.PUBLIC_URL;
const store = openStore(join(dir, 'state.json'), join(dir, 'login.key'));
const { state } = store;

const token = randomBytes(32).toString('hex');
const redirect_uri = 'https://example.com/callback';
const servers: http.Server[] = [];
before(() => { state.profiles.fixture = { allow: [], tokenHash: hash(token), logins: {}, createdAt: 0 }; });
after(() => { for (const s of servers) s.close(); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function serve() {
  const { createOAuth } = await import(new URL(`../../oauth.mjs?${++n}`, import.meta.url).href);
  const oauth = createOAuth(store);
  const server = http.createServer((req, res) => oauth(req, res, { audit() {} }).catch(() => res.writeHead(500).end()));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const post = (path: string, body: object, headers = {}) => fetch(base + path, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const register = async (body: object = { redirect_uris: [redirect_uri], token_endpoint_auth_method: 'none' }) => {
    const r = await post('/register', body);
    assert.equal(r.status, 201);
    return r.json();
  };
  const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
  const authorize = (client_id: string, extra: Record<string, string> = {}) => fetch(base + '/authorize?' + new URLSearchParams({
    client_id, redirect_uri, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, ...extra,
  }), { redirect: 'manual' });
  const pending = async (client_id: string) => (await (await authorize(client_id)).text()).match(/name="pending" value="([^"]+)"/)![1];
  return { base, post, register, authorize, pending };
}

test('registration budget: 20 per hour', async () => {
  const { post } = await serve();
  const body = { redirect_uris: [redirect_uri], token_endpoint_auth_method: 'none' };
  for (let i = 0; i < 20; i++) assert.equal((await post('/register', body)).status, 201, `registration ${i + 1}`);
  assert.equal((await post('/register', body)).status, 429);
});

test('registration refused past 1000 clients', async () => {
  const { post } = await serve();
  const saved = state.clients;
  state.clients = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`seed${i}`, { redirect_uris: [redirect_uri] }]));
  try {
    assert.equal((await post('/register', { redirect_uris: [redirect_uri] })).status, 429);
  } finally { state.clients = saved; }
});

test('registration validates redirect URIs and auth method', async () => {
  const { post } = await serve();
  for (const redirect_uris of [['http://evil.com/cb'], [], 'https://example.com/cb', Array(11).fill(redirect_uri), ['https://a.com/cb#x']])
    assert.equal((await post('/register', { redirect_uris })).status, 400, JSON.stringify(redirect_uris));
  assert.equal((await post('/register', { redirect_uris: [redirect_uri], token_endpoint_auth_method: 'private_key_jwt' })).status, 400);
});

test('consent budget: 40 attempts per minute', async () => {
  const { register, pending, post } = await serve();
  const { client_id } = await register();
  let id = '';
  for (let i = 0; i < 40; i++) {
    if (i % 4 === 0) id = await pending(client_id); // 5 bad tries drop a pending authorization
    assert.equal((await post('/authorize', { pending: id, token: 'wrong' })).status, 401, `attempt ${i + 1}`);
  }
  assert.equal((await post('/authorize', { pending: await pending(client_id), token })).status, 429);
});

test('five bad tokens drop the pending authorization', async () => {
  const { register, pending, post } = await serve();
  const { client_id } = await register();
  const id = await pending(client_id);
  for (let i = 0; i < 5; i++) assert.equal((await post('/authorize', { pending: id, token: 'wrong' })).status, 401);
  const r = await post('/authorize', { pending: id, token });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /expired/);
});

test('authorize: unknown client, foreign redirect, PKCE and response_type', async () => {
  const { register, authorize } = await serve();
  const { client_id } = await register();
  assert.equal((await authorize('acc_nope')).status, 400);
  assert.equal((await authorize('__proto__')).status, 400);
  assert.equal((await authorize(client_id, { redirect_uri: 'https://evil.example/cb' })).status, 400);
  const errorOf = async (extra: Record<string, string>) => {
    const r = await authorize(client_id, extra);
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location')!);
    assert.equal(loc.origin + loc.pathname, redirect_uri);
    return loc.searchParams.get('error');
  };
  assert.equal(await errorOf({ code_challenge: '' }), 'invalid_request');
  assert.equal(await errorOf({ code_challenge_method: 'plain' }), 'invalid_request');
  assert.equal(await errorOf({ response_type: 'token' }), 'unsupported_response_type');
});

test('confidential client: token endpoint requires its secret', async () => {
  const { register, post } = await serve();
  const { client_id, client_secret } = await register({ redirect_uris: [redirect_uri] }); // default client_secret_basic
  assert.match(client_secret, /^accs_/);
  const grant = { grant_type: 'authorization_code', code: 'x', code_verifier: 'v'.repeat(43), redirect_uri };
  assert.equal((await post('/token', { ...grant, client_id })).status, 401);
  assert.equal((await post('/token', { ...grant, client_id, client_secret: 'accs_wrong' })).status, 401);
  const basic = 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64');
  const r = await post('/token', grant, { authorization: basic });
  assert.equal(r.status, 400); // authenticated, then the bogus code is refused
  assert.equal((await r.json()).error, 'invalid_grant');
});

test('unsupported grant type', async () => {
  const { register, post } = await serve();
  const { client_id } = await register();
  assert.equal((await post('/token', { grant_type: 'password', client_id })).status, 400);
});
