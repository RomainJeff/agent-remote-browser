// Better Auth edge cases in-process (no gateway, no Docker): DCR budgets, rate limits, signups, admins without TOTP.
// The happy path through the real gateway lives in test/integration/gateway.test.ts. Every secret is synthetic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openStore } from '../../src/store/store.ts';
import { openDb, tx } from '../../src/store/db.ts';
import { createAuth } from '../../src/auth/better-auth.ts';
import { createAuthRoutes } from '../../src/auth/routes.ts';
import { requireAdmin } from '../../src/auth/guards.ts';

const dir = mkdtempSync(join(tmpdir(), 'arb-auth-'));
const db = openDb(join(dir, 'arb.db'));
const base = 'http://127.0.0.1:1';
const { auth, pending } = createAuth(db, { baseURL: base, secret: randomBytes(32).toString('hex'), trustedOrigins: [base] });
const servers: http.Server[] = [];
after(() => { for (const s of servers) s.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

/** The public routes on a real socket; a fresh instance = fresh in-process DCR budget. */
async function serve() {
  const routes = createAuthRoutes({ db, auth, store: openStore(db, join(dir, 'login.key')) }, pending, base);
  const server = http.createServer((req, res) => routes.handle(req, res).then((done) => { if (!done) res.writeHead(404).end(); }));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const register = (ip = '198.51.100.1') => fetch(url + '/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }) });
  return { url, register };
}
/** Straight to Better Auth, as one client IP. */
const hit = (path: string, body: object, ip: string) => auth.handler(new Request(base + '/api/auth' + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'cf-connecting-ip': ip }, body: JSON.stringify(body) }));

test('DCR: 5 per minute per client IP, 20 attempts per hour overall, then 429', async () => {
  const { register } = await serve();
  for (let i = 0; i < 5; i++) assert.equal((await register('192.0.2.1')).status, 201, `registration ${i + 1}`);
  assert.equal((await register('192.0.2.1')).status, 429, 'per IP (oauth-provider rule)');
  // The refused attempt above counts against the hourly budget too.
  for (let i = 6; i < 20; i++) assert.equal((await register(`192.0.2.${i + 10}`)).status, 201, `registration ${i + 1}`);
  const r = await register('192.0.2.200');
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: 'temporarily_unavailable' });
});

test('DCR: refused past 1000 clients', async () => {
  const { register } = await serve();
  const n = (db.prepare('SELECT count(*) n FROM oauthClient').get() as { n: number }).n;
  const add = db.prepare('INSERT INTO oauthClient (id, clientId, redirectUris) VALUES (?, ?, ?)');
  tx(db, () => { for (let i = n; i < 1000; i++) add.run(`seed${i}`, `seed${i}`, '["http://127.0.0.1:9/cb"]'); });
  try { assert.equal((await register()).status, 429); }
  finally { db.exec("DELETE FROM oauthClient WHERE id LIKE 'seed%'"); }
});

test('rate limits on sign-in, consent and token, stored in the database', async () => {
  for (const [path, max] of [['/sign-in/email', 5], ['/oauth2/consent', 10], ['/oauth2/token', 30]] as const) {
    const ip = `198.51.100.${max}`;
    for (let i = 0; i < max; i++) assert.notEqual((await hit(path, { email: 'x@example.test', password: 'y'.repeat(12) }, ip)).status, 429, `${path} ${i + 1}`);
    assert.equal((await hit(path, {}, ip)).status, 429, path);
    assert.notEqual((await hit(path, {}, '198.51.100.200')).status, 429, `${path}: per client IP`);
  }
  assert.ok((db.prepare('SELECT count(*) n FROM rateLimit').get() as { n: number }).n >= 3);
});

test('signup is disabled and not routed', async () => {
  await assert.rejects(auth.api.signUpEmail({ body: { email: 'x@example.test', password: 'y'.repeat(16), name: 'x' } }));
  const { url } = await serve();
  const r = await fetch(url + '/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'x@example.test', password: 'y'.repeat(16), name: 'x' }) });
  assert.equal(r.status, 404);
  for (const p of ['/api/auth/sign-in/email', '/api/auth/two-factor/verify-totp', '/api/auth/get-session', '/api/auth/api-key/create'])
    assert.equal((await fetch(url + p, { method: 'POST' })).status, 404, p);
  assert.equal((db.prepare('SELECT count(*) n FROM user').get() as { n: number }).n, 0);
});

test('an admin without TOTP gets a session but no admin rights', async () => {
  const ctx = await auth.$context;
  const password = randomBytes(12).toString('base64url');
  const user = await ctx.internalAdapter.createUser({ email: 'half@example.test', name: 'Admin', emailVerified: true }, { method: 'admin' });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(password) });
  const r = await hit('/sign-in/email', { email: 'half@example.test', password }, '198.51.100.99');
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.ok((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.session, 'Better Auth sees a session');
  assert.equal(await requireAdmin(auth, { cookie }), null);
});
