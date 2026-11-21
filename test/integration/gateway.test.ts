// The real gateway in-process, on free ports, with temp state, driving a real runner (src/runner/server.ts) over its
// Unix socket; the runner drives an in-memory FakeDriver (records every host call, returns canned agent-browser
// output). Every host call thus crosses the runner's validation, as in production. Tests share one gateway and run in order: later tests rely on the
// admin session, profiles and keys created by earlier ones. Every secret here is synthetic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start } from '../../src/server.ts';
import { main } from '../../src/cli.ts';
import { loadConfig } from '../../src/config.ts';
import { FakeDriver } from '../../src/host/fake.ts';
import { RunnerDriver } from '../../src/host/runner.ts';
import { serveRunner } from '../../src/runner/server.ts';
import { parseProfileId } from '../../src/policy.ts';
import { purgeClients } from '../../src/auth/guards.ts';
import { totp } from '../totp.ts';

const dir = mkdtempSync(join(tmpdir(), 'arb-gw-'));
const f = {
  data: join(dir, 'data'), audit: join(dir, 'audit.jsonl'), kill: join(dir, 'KILL'),
  key: join(dir, 'login.key'), egress: join(dir, 'egress'),
};
const fake = new FakeDriver();
const runnerSock = join(dir, 'runner.sock');
let runner: net.Server;
let app: Awaited<ReturnType<typeof start>>, PORT = 0, ADMIN = 0, base = '';
const tokens = { global: '', shop: '' };
const owner = { email: 'admin@example.test', password: randomBytes(12).toString('base64url'), uri: '', backup: [] as string[] };
/** Cookie header of the signed-in admin, sent by admin() unless a test overrides it. */
let session = '';

const env = () => ({
  PORT: String(PORT), ADMIN_PORT: String(ADMIN), PUBLIC_URL: base, DATA_DIR: f.data, AUDIT_FILE: f.audit, KILL_FILE: f.kill,
  LOGIN_KEY_FILE: f.key, EGRESS_DIR: f.egress, RUNNER_SOCKET: runnerSock, BETTER_AUTH_SECRET: 'synthetic-' + 'x'.repeat(40),
});
const boot = (extra = {}) => start(loadConfig({ ...env(), ...extra }), new RunnerDriver(runnerSock));

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

/** Graceful close, then boot on new ports: fetch's keep-alive pool may hold a socket the old server closed. */
async function restart(extra: Record<string, string> = {}) {
  await app.close();
  fake.calls = [];
  [PORT, ADMIN] = [await freePort(), await freePort()];
  base = `http://127.0.0.1:${PORT}`;
  app = await boot(extra);
}

before(async () => {
  [PORT, ADMIN] = [await freePort(), await freePort()];
  base = `http://127.0.0.1:${PORT}`;
  // The admin, created like an operator would: password then the code from the authenticator app.
  const lines: string[] = [];
  const answers = [() => owner.password, () => totp(owner.uri)];
  assert.equal(await main(['admin', 'create', owner.email], env(), (l) => {
    lines.push(l);
    if (l.startsWith('otpauth://')) owner.uri = l;
    if (/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(l)) owner.backup.push(l);
  }, undefined, async () => answers.shift()!()), 0);
  assert.equal(lines.filter((l) => l.includes(owner.password)).length, 0, 'password never printed');
  assert.equal(owner.backup.length, 10, 'backup codes printed once at enrollment');
  // A stopped leftover of an unknown profile: startup must not touch it.
  fake.computers.set('ghost', { id: 'ghost', running: true });
  runner = await serveRunner(fake, runnerSock);
  app = await boot();
});
after(async () => { await app?.close(); runner?.close(); rmSync(dir, { recursive: true, force: true }); });

/** name=value pairs of Set-Cookie headers, merged over an existing Cookie header (cleared cookies dropped). */
function jar(setCookies: string[], cookie = '') {
  const m = new Map(cookie.split('; ').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv]));
  for (const c of setCookies) {
    const kv = c.split(';')[0], name = kv.slice(0, kv.indexOf('='));
    if (kv.length > name.length + 1) m.set(name, kv); else m.delete(name);
  }
  return [...m.values()].join('; ');
}

/** Raw admin request: full control over Host, Origin, Cookie and fetch metadata headers. */
function admin(method: string, path: string, { body, headers = {} }: { body?: unknown, headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number, json: any, cookies: string[] }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ADMIN, method, path,
      headers: { host: `127.0.0.1:${ADMIN}`, ...(session && { cookie: session }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => { let json; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode!, json, cookies: [res.headers['set-cookie'] ?? []].flat() }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
const adminOrigin = () => ({ origin: `http://127.0.0.1:${ADMIN}`, cookie: '' });

async function mcp<T>(token: string, fn: (c: Client) => Promise<T>) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  try { return await fn(client); } finally { await client.close(); }
}
/** Calls one tool, returns { error, text }. */
const call = (token: string, name: string, args: Record<string, unknown> = {}) => mcp(token, async (c) => {
  const r = await c.callTool({ name, arguments: args }) as { isError?: boolean, content: { text: string }[] };
  return { error: !!r.isError, text: r.content[0].text };
});
const toolNames = (token: string) => mcp(token, async (c) => (await c.listTools()).tools.map((t) => t.name).sort());
const mcpStatus = async (headers: Record<string, string>) =>
  (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })).status;
const dbFile = () => join(f.data, 'arb.db');
/** Every row of every table, read through a second connection (sees WAL content). */
function dump() {
  const db = new DatabaseSync(dbFile(), { readOnly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'rateLimit'").all() as { name: string }[]).map((r) => r.name);
    return JSON.stringify(names.map((n) => [n, db.prepare(`SELECT * FROM "${n}"`).all()]));
  } finally { db.close(); }
}
/** Raw bytes of the database and its WAL, as latin1 text for substring checks. */
const rawDb = () => ['', '-wal'].map((s) => existsSync(dbFile() + s) ? readFileSync(dbFile() + s, 'latin1') : '').join('');
const calls = (op: string) => fake.calls.filter((c) => c.op === op);
const agentBrowser = (op: string) => calls('exec').filter((c) => c.argv![0] === 'agent-browser' && c.argv!.includes(op));

test('startup lists its computers, leaves unknown ones alone; probes answer without auth', async () => {
  assert.deepEqual(fake.calls, [{ op: 'list' }]);
  assert.equal(await (await fetch(base + '/healthz')).text(), 'ok');
  const ready = await fetch(base + '/readyz');
  assert.equal(ready.status, 200);
  assert.equal(await ready.text(), 'ready');
  fake.computers.delete('ghost');
});

test('admin API: refused without a session, without TOTP, and with a wrong password; no public signup', async () => {
  assert.equal((await admin('GET', '/api/computers')).status, 401);
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'x', allow: ['example.com'] } })).status, 401);
  assert.equal((await admin('POST', '/api/auth/sign-in/email', { body: { email: owner.email, password: 'wrong-password' }, headers: adminOrigin() })).status, 401);
  // Password alone: Better Auth answers with a two-factor challenge and no session.
  const half = await admin('POST', '/api/auth/sign-in/email', { body: { email: owner.email, password: owner.password }, headers: adminOrigin() });
  assert.equal(half.status, 200);
  assert.equal(half.json.twoFactorRedirect, true);
  assert.equal((await admin('GET', '/api/computers', { headers: { cookie: jar(half.cookies) } })).status, 401);
  const wrongCode = String((Number(totp(owner.uri)) + 1) % 1e6).padStart(6, '0');
  assert.equal((await admin('POST', '/api/auth/two-factor/verify-totp', { body: { code: wrongCode },
    headers: { ...adminOrigin(), cookie: jar(half.cookies) } })).status, 401);
  // Signup is neither routed nor enabled.
  assert.equal((await admin('POST', '/api/auth/sign-up/email', { body: { email: 'x@example.test', password: 'y'.repeat(16), name: 'x' }, headers: adminOrigin() })).status, 401);
  const signup = await fetch(base + '/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'x@example.test', password: 'y'.repeat(16), name: 'x' }) });
  assert.equal(signup.status, 404);
  assert.ok(!dump().includes('x@example.test'));

  const ok = await admin('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(owner.uri) }, headers: { ...adminOrigin(), cookie: jar(half.cookies) } });
  assert.equal(ok.status, 200);
  session = jar(ok.cookies, jar(half.cookies));
  assert.equal((await admin('GET', '/api/computers')).status, 200);
});

test('admin creates profiles and scoped API keys; MCP without a valid bearer gets the OAuth hint', async () => {
  const p = await admin('POST', '/api/profiles', { body: { id: 'shop', allow: ['Example.com'] } });
  assert.deepEqual([p.status, p.json], [201, { id: 'shop' }]);
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'shop', allow: ['example.com'] } })).status, 409);
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'Bad', allow: ['example.com'] } })).status, 400);
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'lan', allow: ['nas.lan'] } })).status, 400);

  for (const scope of ['profile:nope', 'profile:../x', 'admin', undefined])
    assert.equal((await admin('POST', '/api/keys', { body: { name: 'k', scope, expiresIn: '30d' } })).status, 400, String(scope));
  // Expiry is mandatory: no "never", no lifetime over a year, no date in the past or under a day.
  const day = 86400_000, inDays = (n: number) => new Date(Date.now() + n * day).toISOString();
  for (const exp of [{}, { expiresIn: 'never' }, { expiresIn: null }, { expiresIn: '7d' }, { expiresIn: 31536000 }, { expiresAt: 'soon' },
    { expiresAt: inDays(-1) }, { expiresAt: inDays(0.5) }, { expiresAt: inDays(366) }])
    assert.equal((await admin('POST', '/api/keys', { body: { name: 'k', scope: 'global', ...exp } })).status, 400, JSON.stringify(exp));
  const key = async (name: string, scope: string, exp: object = { expiresIn: '90d' }) => {
    const r = await admin('POST', '/api/keys', { body: { name, scope, ...exp } });
    assert.equal(r.status, 201);
    assert.match(r.json.key, /^arb_k_/);
    return r.json as { id: string, key: string, expiresAt: string };
  };
  const g = await key('orchestrator', 'global');
  tokens.global = g.key;
  assert.ok(Math.abs(Date.parse(g.expiresAt) - Date.now() - 90 * day) < 60_000, g.expiresAt);
  tokens.shop = (await key('shop agent', 'profile:shop', { expiresIn: '1y' })).key;
  const dated = await key('dated', 'profile:shop', { expiresAt: inDays(10) });
  assert.ok(Math.abs(Date.parse(dated.expiresAt) - Date.now() - 10 * day) < 60_000, dated.expiresAt);
  // A key from before mandatory expiry (expiresAt NULL) still works, flagged noExpiry for rotation.
  const legacy = new DatabaseSync(dbFile());
  try { legacy.prepare('UPDATE apikey SET expiresAt = NULL WHERE id = ?').run(dated.id); } finally { legacy.close(); }
  assert.notEqual(await mcpStatus({ authorization: `Bearer ${dated.key}` }), 401);
  const listed = (await admin('GET', '/api/clients')).json.keys;
  assert.deepEqual(listed.map((k: any) => `${k.name}=${k.scope} ${k.noExpiry}`).sort(), ['dated=profile:shop true', 'orchestrator=global false', 'shop agent=profile:shop false']);
  assert.equal(listed.find((k: any) => k.name === 'orchestrator').expiresAt, g.expiresAt);
  assert.ok(listed.every((k: any) => /^arb_k_.{6}$/.test(k.start)), 'only the first characters are listed');
  assert.equal((await admin('POST', `/api/keys/${dated.id}/revoke`, { body: {} })).status, 200);

  const state = dump() + rawDb();
  assert.ok(!state.includes(tokens.global) && !state.includes(tokens.shop), 'keys stored as hashes only');
  assert.ok(!state.includes(owner.password), 'password stored hashed');
  assert.equal(statSync(f.data).mode & 0o777, 0o700);
  for (const s of ['', '-wal']) assert.equal(statSync(dbFile() + s).mode & 0o777, 0o600, s);

  for (const authorization of [undefined, 'Bearer arb_k_wrong', 'Bearer arb_at_wrong', 'Bearer acp_legacy']) {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization && { authorization }) }, body: '{}' });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  }
  // x-api-key works too; a revoked key is refused at once.
  const spare = await key('spare', 'profile:shop');
  assert.notEqual(await mcpStatus({ 'x-api-key': spare.key }), 401);
  assert.equal((await admin('POST', `/api/keys/${spare.id}/revoke`, { body: {} })).status, 200);
  assert.equal(await mcpStatus({ authorization: `Bearer ${spare.key}` }), 401);
  assert.equal((await admin('POST', `/api/keys/${spare.id}/revoke`, { body: {} })).status, 404);
});

test('profile key: browser tools only, open outside the allowlist never reaches the host', async () => {
  const names = await toolNames(tokens.shop);
  assert.deepEqual(names, ['back', 'click', 'fill', 'get_text', 'login', 'open', 'press', 'screenshot', 'snapshot']);
  for (const url of ['https://example.org/', 'http://169.254.169.254/', 'https://example.com:8443/', 'file:///etc/passwd']) {
    const r = await call(tokens.shop, 'open', { url });
    assert.ok(r.error, url);
    assert.match(r.text, /^Domain not allowed/, url);
  }
  assert.equal(calls('ensure').length, 0);
});

test('open on the allowlist starts one computer, behind its own egress proxy', async () => {
  const r = await call(tokens.shop, 'open', { url: 'https://www.example.com/' });
  assert.ok(!r.error, r.text);
  assert.deepEqual(JSON.parse(r.text), { title: 'Fake page', url: 'https://www.example.com/' });
  const first = fake.computers.get('shop')!;
  await call(tokens.shop, 'open', { url: 'https://example.com/' });
  assert.deepEqual([...fake.computers.keys()], ['shop']);
  assert.equal(fake.computers.get('shop'), first, 'second call reuses the running computer');
  assert.ok(calls('ensure').every((c) => c.id === 'shop'));
  assert.equal(statSync(join(f.egress, 'shop', 'proxy.sock')).mode & 0o777, 0o666);

  const snap = await call(tokens.shop, 'snapshot');
  assert.match(snap.text, /^<untrusted_page_content origin="https:\/\/example.com">/);
});

test('saved login: password only reaches the host through stdin', async () => {
  const password = randomBytes(18).toString('base64url');
  assert.equal((await admin('POST', '/api/computers/shop/login-save',
    { body: { site: 'main', url: 'https://example.org/login', username: 'fixture', password } })).status, 400, 'URL off the allowlist');
  assert.equal((await admin('POST', '/api/computers/shop/login-save',
    { body: { site: 'main', url: 'https://example.com/login', username: 'fixture', password } })).status, 200);

  const r = await call(tokens.shop, 'login', { site: 'main' });
  assert.ok(!r.error, r.text);
  assert.equal(JSON.parse(r.text).submitted, true);
  assert.equal((await call(tokens.shop, 'login', { site: 'other' })).error, true);

  const saves = agentBrowser('--password-stdin');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].stdin, password, 'password went through stdin');
  assert.ok(fake.calls.every((c) => c === saves[0] || !JSON.stringify(c).includes(password)), 'nowhere else');
  assert.ok(!saves[0].argv!.includes(password));
  assert.equal(agentBrowser('delete').length, 1, 'in-container vault entry deleted');
  const details = await admin('GET', '/api/computers/shop');
  assert.deepEqual(details.json.logins, [{ site: 'main', url: 'https://example.com/login', username: 'fixture' }]);
  assert.ok(!dump().includes(password) && !rawDb().includes(password), 'database');
  assert.ok(!readFileSync(f.audit, 'utf8').includes(password), 'audit');
  assert.ok(!JSON.stringify(details.json).includes(password));
});

test('kill switch refuses every tool until removed', async () => {
  writeFileSync(f.kill, '');
  try {
    const before = fake.calls.length;
    const r = await call(tokens.shop, 'open', { url: 'https://example.com/' });
    assert.deepEqual(r, { error: true, text: 'agent-remote-browser is disabled (kill switch)' });
    assert.equal(fake.calls.length, before);
    const { agent, tool, ok } = JSON.parse(readFileSync(f.audit, 'utf8').trim().split('\n').at(-1)!);
    assert.deepEqual({ agent, tool, ok }, { agent: 'shop', tool: 'open', ok: false });
  } finally { rmSync(f.kill); }
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
});

test('a lease locks the profile key; the global key drives the profile through the lease', async () => {
  assert.deepEqual(await toolNames(tokens.global),
    ['back', 'click', 'create_profile', 'fill', 'get_text', 'lease_profile', 'list_profiles', 'login', 'open', 'press', 'release_profile', 'screenshot', 'snapshot']);
  assert.match((await call(tokens.global, 'open', { lease: 'arb_l_bogus', url: 'https://example.com/' })).text, /Unknown or expired lease/);
  assert.match((await call(tokens.global, 'lease_profile', { domain: 'example.org' })).text, /No free profile/);

  const leased = await call(tokens.global, 'lease_profile', { domain: 'www.example.com', minutes: 5 });
  assert.ok(!leased.error, leased.text);
  const { lease, profile } = JSON.parse(leased.text);
  assert.equal(profile, 'shop');
  assert.match((await call(tokens.shop, 'open', { url: 'https://example.com/' })).text, /^This browser is leased until /);
  assert.match((await call(tokens.global, 'lease_profile', { profile: 'shop' })).text, /already leased/);
  const viaLease = await call(tokens.global, 'open', { lease, url: 'https://example.com/a' });
  assert.ok(!viaLease.error, viaLease.text);
  // Admin extends the lease: now + N minutes, and the agent's next call slides it by N (not the original 5).
  const extend = (minutes: unknown) => admin('POST', '/api/computers/shop/extend', { body: { minutes } });
  for (const bad of [0, 121, 1.5, '60']) assert.equal((await extend(bad)).status, 400, String(bad));
  const ext = await extend(60);
  assert.equal(ext.status, 200);
  assert.ok(Math.abs(Date.parse(ext.json.leasedUntil) - Date.now() - 3600_000) < 5000);
  await call(tokens.global, 'open', { lease, url: 'https://example.com/b' });
  const until = (await admin('GET', '/api/computers')).json.find((c: any) => c.id === 'shop').leasedUntil;
  assert.ok(Date.parse(until) - Date.now() > 3500_000, until);
  assert.deepEqual(JSON.parse((await call(tokens.global, 'release_profile', { lease })).text), { released: true });
  assert.equal((await extend(60)).status, 404, 'no live lease');
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
  const last = JSON.parse(readFileSync(f.audit, 'utf8').trim().split('\n').findLast((l) => l.includes('"via"'))!);
  assert.equal(last.via, 'global');
});

test('/metrics: admin listener only, no session, counts without ids or secrets', async () => {
  const scrape = (port: number, host: string) => new Promise<{ status: number, type?: string, text: string }>((resolve, reject) =>
    http.get({ host: '127.0.0.1', port, path: '/metrics', headers: { host } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; }).on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'], text }));
    }).on('error', reject));
  // One egress refusal, straight on the profile's proxy socket: a private address.
  const denied = await new Promise<string>((resolve) => {
    const s = net.connect(join(f.egress, 'shop', 'proxy.sock'), () => s.write('CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: 10.0.0.1:443\r\n\r\n'));
    let r = ''; s.on('data', (d) => { r += d; }).on('close', () => resolve(r));
  });
  assert.match(denied, /^HTTP\/1\.1 403/);
  await mcpStatus({ authorization: 'Bearer arb_k_bogus' });

  const r = await scrape(ADMIN, `127.0.0.1:${ADMIN}`);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'text/plain; version=0.0.4; charset=utf-8');
  const value = (series: string) => Number(r.text.match(new RegExp(`^${series.replace(/[{}]/g, '\\$&')} (\\d+)$`, 'm'))?.[1]);
  assert.ok(value('arb_tool_calls_total{tool="open",outcome="ok"}') >= 1);
  assert.ok(value('arb_tool_calls_total{tool="open",outcome="error"}') >= 1, 'kill switch refusals');
  assert.ok(value('arb_auth_failures_total{kind="token"}') >= 1);
  assert.ok(value('arb_auth_failures_total{kind="password"}') >= 1, 'wrong password earlier');
  assert.ok(value('arb_egress_denied_total') >= 1);
  assert.ok(value('arb_http_requests_total{listener="mcp"}') >= 1);
  assert.equal(value('arb_runner_up'), 1);
  assert.equal(value('arb_computers_running'), [...fake.computers.values()].filter((c) => c.running).length);
  assert.equal(value('arb_leases_active'), 0);
  for (const line of r.text.split('\n').filter(Boolean)) assert.match(line, /^(# (HELP|TYPE) arb_\w+ .+|arb_\w+(\{(\w+="[\w-]+",?)+\})? \d+)$/, line);
  for (const t of Object.values(tokens)) assert.ok(!r.text.includes(t));

  // Scrapers on the host (localhost) or the stack's network (service name) pass; a rebinding domain does not.
  assert.equal((await scrape(ADMIN, `localhost:${ADMIN}`)).status, 200);
  assert.equal((await scrape(ADMIN, 'gateway:18788')).status, 200);
  assert.equal((await scrape(ADMIN, `rebind.example.com:${ADMIN}`)).status, 403);
  // Never on the public listener, ADMIN_PUBLIC or not.
  assert.equal((await scrape(PORT, `127.0.0.1:${PORT}`)).status, 404);
});

test('admin refuses cross-origin, cross-site, foreign Host and non-JSON writes, even with a session', async () => {
  const state = dump();
  const write = { name: 'csrf', scope: 'global', expiresIn: '30d' };
  for (const headers of [{ origin: 'http://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' }, { host: `evil.test:${ADMIN}` }, { host: `127.0.0.1:${PORT}` }] as Record<string, string>[]) {
    assert.equal((await admin('GET', '/api/computers', { headers })).status, 403, JSON.stringify(headers));
    assert.equal((await admin('POST', '/api/keys', { body: write, headers })).status, 403, JSON.stringify(headers));
    assert.equal((await admin('POST', '/api/auth/sign-in/email', { body: { email: owner.email, password: owner.password }, headers })).status, 403, JSON.stringify(headers));
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])
    assert.equal((await admin('POST', '/api/keys', { body: JSON.stringify(write), headers: { 'content-type': type } })).status, 415, type);
  assert.equal((await admin('POST', '/api/keys', { body: JSON.stringify(write), headers: { 'content-type': '' } })).status, 415);
  assert.equal(dump(), state, 'no refused write changed state');
  assert.equal((await admin('GET', '/api/computers', { headers: { origin: `http://127.0.0.1:${ADMIN}`, 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('live view WebSocket: cross-origin upgrade dropped before touching the computer', async () => {
  const upgrade = (headers: Record<string, string>) => new Promise<string>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: ADMIN, path: '/api/computers/shop/stream', headers: {
      host: `127.0.0.1:${ADMIN}`, cookie: session, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } });
    req.on('upgrade', () => resolve('upgraded'));
    req.on('response', (r) => resolve('http ' + r.statusCode));
    req.on('error', () => resolve('dropped'));
    req.end();
  });
  const streams = () => agentBrowser('stream').length;
  const n = streams();
  assert.equal(await upgrade({ origin: 'http://evil.test' }), 'dropped');
  assert.equal(await upgrade({ host: `evil.test:${ADMIN}` }), 'dropped');
  assert.equal(await upgrade({ cookie: '' }), 'dropped', 'no session');
  assert.equal(streams(), n, 'no host call for refused upgrades');
  const relays = calls('stream').length;
  // Same-origin reaches the computer (the fake relay exits at once, so the socket closes without a 101).
  await upgrade({ origin: `http://127.0.0.1:${ADMIN}` });
  assert.equal(streams(), n + 1);
  assert.equal(calls('stream').length, relays + 1);
});

test('OAuth: DCR, login + TOTP, consent picks the profile, PKCE, refresh rotation, purge, revocation', async () => {
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'other', allow: ['example.org'] } })).status, 201);
  const meta = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
  assert.deepEqual([meta.resource, meta.authorization_servers], [base + '/mcp', [base + '/api/auth']]);
  const as = await (await fetch(base + '/.well-known/oauth-authorization-server/api/auth')).json();
  assert.equal(as.issuer, base + '/api/auth');
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.ok(!JSON.stringify(as).includes('/sign-up'));

  const redirect_uri = 'http://127.0.0.1:9/callback', resource = base + '/mcp';
  const register = (body: object) => fetch(base + '/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reg = await register({ redirect_uris: [redirect_uri], token_endpoint_auth_method: 'none', client_name: 'test client' });
  assert.ok(reg.ok, String(reg.status));
  const { client_id } = await reg.json();
  const abandoned = (await (await register({ redirect_uris: [redirect_uri], token_endpoint_auth_method: 'none' })).json()).client_id;

  const code_verifier = randomBytes(32).toString('base64url');
  const code_challenge = createHash('sha256').update(code_verifier).digest('base64url');
  const authorizeQuery = new URLSearchParams({ client_id, redirect_uri, response_type: 'code', code_challenge_method: 'S256', code_challenge,
    state: 'xyz', scope: 'mcp offline_access', resource });
  // A browser navigation: Better Auth only redirects those (fetch calls get JSON). Raw http: Node's fetch forces
  // sec-fetch-mode: cors.
  const get = (path: string, cookie = '') => new Promise<Response>((resolve, reject) => {
    http.get(new URL(path, base), { headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate' } }, (r) => {
      let raw = '';
      r.on('data', (d) => { raw += d; });
      r.on('end', () => resolve(new Response(raw, { status: r.statusCode, headers: Object.entries(r.headers).filter(([k]) => k !== 'set-cookie').map(([k, v]) => [k, String(v)]) })));
    }).on('error', reject);
  });
  const postForm = (path: string, form: Record<string, string>, cookie = '', origin = base) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin && { origin }), ...(cookie && { cookie }) }, body: new URLSearchParams(form) });
  const queryOf = (r: Response) => new URL(r.headers.get('location')!, base).search.slice(1);

  // No session: authorize -> /login. Consent without a session sends to /login too.
  const toLogin = await get('/api/auth/oauth2/authorize?' + authorizeQuery);
  assert.equal(toLogin.status, 302);
  assert.equal(new URL(toLogin.headers.get('location')!, base).pathname, '/login');
  const q = queryOf(toLogin);
  const noSession = await get('/consent?' + q);
  assert.equal(noSession.status, 302);
  assert.equal(noSession.headers.get('location'), '/login?' + q);
  assert.equal((await postForm('/consent', { scope: 'profile:shop', accept: 'true', oauth_query: q })).status, 302);

  const loginPage = await get('/login?' + q);
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await postForm('/login', { email: owner.email, password: owner.password, oauth_query: q }, '', 'http://evil.test')).status, 403);
  const step1 = await postForm('/login', { email: owner.email, password: owner.password, oauth_query: q });
  assert.equal(step1.status, 200);
  assert.match(await step1.text(), /Two-factor code[\s\S]*name="backupCode"/, 'no-JS backup code form');
  const badBackup = await postForm('/login', { backupCode: 'aaaaa-bbbbb', oauth_query: q }, jar(step1.headers.getSetCookie()));
  assert.equal(badBackup.status, 401);
  assert.match(await badBackup.text(), /Invalid or expired code/);
  const step2 = await postForm('/login', { code: totp(owner.uri), oauth_query: q }, jar(step1.headers.getSetCookie()));
  assert.equal(step2.status, 302);
  const cookie = jar(step2.headers.getSetCookie(), jar(step1.headers.getSetCookie()));
  assert.equal(new URL(step2.headers.get('location')!, base).pathname, '/consent');
  // Lost phone: a backup code also completes the OAuth sign-in, once.
  const again = await postForm('/login', { email: owner.email, password: owner.password, oauth_query: q });
  const viaBackup = await postForm('/login', { backupCode: owner.backup.shift()!, oauth_query: q }, jar(again.headers.getSetCookie()));
  assert.equal(viaBackup.status, 302);
  assert.equal(new URL(viaBackup.headers.get('location')!, base).pathname, '/consent');

  /** Consent page -> code, for a session that already signed in (authorize then goes straight to consent). */
  const grant = async (scope: string) => {
    const toConsent = await get('/api/auth/oauth2/authorize?' + authorizeQuery, cookie);
    assert.equal(new URL(toConsent.headers.get('location')!, base).pathname, '/consent');
    const cq = queryOf(toConsent);
    const page = await get('/consent?' + cq, cookie);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /test client/);
    assert.match(html, /value="profile:other"/);
    assert.ok(html.includes(client_id));
    assert.match(html, /client non vérifié/);
    assert.match(html, /Registered \d+ min ago/);
    assert.match(html, /Loopback redirect/);
    assert.match(html, /Global: manage and lease every profile \(not recommended for an unverified client\)/);
    assert.equal((await postForm('/consent', { scope: 'profile:nope', accept: 'true', oauth_query: cq }, cookie)).status, 400);
    assert.equal((await postForm('/consent', { scope, accept: 'true', oauth_query: cq }, cookie, 'http://evil.test')).status, 403);
    let r = await postForm('/consent', { scope, accept: 'true', oauth_query: cq }, cookie);
    if (scope === 'global') {
      assert.equal(r.status, 200);
      const warn = await r.text();
      assert.match(warn, /Unverified client with Global access/);
      assert.match(warn, /name="confirm" value="global"/);
      r = await postForm('/consent', { scope, confirm: 'global', accept: 'true', oauth_query: cq }, cookie);
    }
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location')!);
    assert.equal(loc.origin + loc.pathname, redirect_uri);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    return loc.searchParams.get('code')!;
  };
  const token = (form: Record<string, string>) => postForm('/api/auth/oauth2/token', { client_id, resource, ...form }, '', '');
  const exchange = (code: string, verifier = code_verifier) => token({ grant_type: 'authorization_code', redirect_uri, code, code_verifier: verifier });

  // Global for an unverified (DCR) client: a second page with a strong warning, then the grant.
  const globalCode = await grant('global');
  assert.ok(globalCode);
  // Everything the client controls is escaped.
  const evil = (await (await register({ redirect_uris: ['https://x.test/cb'], token_endpoint_auth_method: 'none', client_name: '<img src=x onerror=alert(1)>' })).json()).client_id;
  const evilPage = await (await get('/consent?' + new URLSearchParams({ client_id: evil, redirect_uri: 'https://x"><script>.test/cb' }), cookie)).text();
  assert.equal(evilPage.match(/<h1>.*<\/h1>/)?.[0], "<h1>Connect &#60;img src=x onerror=alert(1)&#62;</h1>");
  assert.ok(!evilPage.includes('<script>') && !/Loopback/.test(evilPage));
  // A CIMD client (metadata fetched from its https client_id) shows as verified, no warning page.
  const cimdId = 'https://client.example.test/meta.json';
  sql((db) => db.prepare(`INSERT INTO oauthClient (id, clientId, clientDiscoveryId, name, createdAt, redirectUris) VALUES ('c1', ?, 'cimd', 'Docs app', ?, '[]')`)
    .run(cimdId, new Date(Date.now() - 3 * 86400_000).toISOString()));
  const cimdPage = await (await get('/consent?' + new URLSearchParams({ client_id: cimdId, redirect_uri: 'https://client.example.test/cb' }), cookie)).text();
  assert.match(cimdPage, /Verified by its metadata URL \(CIMD\)[\s\S]*Registered 3 days ago/);
  assert.ok(!/non vérifié|not recommended/.test(cimdPage));
  sql((db) => db.prepare('DELETE FROM oauthClient WHERE id = ?').run('c1'));

  // PKCE failure: refused.
  const burnt = await grant('profile:shop');
  assert.equal((await exchange(burnt, randomBytes(32).toString('base64url'))).status, 400);

  // Code replay: refused, and the tokens of that code die with it (RFC 6749 4.1.2).
  const once = await grant('profile:shop');
  const first = (await (await exchange(once)).json()).access_token;
  assert.notEqual(await mcpStatus({ authorization: `Bearer ${first}` }), 401);
  assert.equal((await exchange(once)).status, 400, 'code replay');
  assert.equal(await mcpStatus({ authorization: `Bearer ${first}` }), 401);

  const code = await grant('profile:shop');
  const ok = await exchange(code);
  assert.equal(ok.status, 200);
  const issued = await ok.json();
  assert.match(issued.access_token, /^arb_at_/);
  assert.match(issued.refresh_token, /^arb_rt_/);
  assert.ok(!(dump() + rawDb()).includes(issued.access_token.slice(7)), 'access token stored hashed');

  // The token is the profile the admin picked: browser tools on shop, nothing global, other profiles out of reach.
  assert.deepEqual(await toolNames(issued.access_token), await toolNames(tokens.shop));
  assert.equal((await call(issued.access_token, 'open', { url: 'https://example.com/' })).error, false);
  assert.match((await call(issued.access_token, 'open', { url: 'https://example.org/' })).text, /^Domain not allowed/, 'example.org is other\'s');
  assert.equal((await call(issued.access_token, 'lease_profile', { profile: 'other' })).error, true);
  const otherCode = await grant('profile:other');
  const otherToken = (await (await exchange(otherCode)).json()).access_token;
  assert.equal((await call(otherToken, 'open', { url: 'https://example.org/' })).error, false);
  assert.match((await call(otherToken, 'open', { url: 'https://example.com/' })).text, /^Domain not allowed/);
  assert.ok(calls('ensure').some((c) => c.id === 'other'));

  const refresh = (refresh_token: string) => token({ grant_type: 'refresh_token', refresh_token });
  const rotated = await refresh(issued.refresh_token);
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.match(next.access_token, /^arb_at_/);
  assert.equal((await call(next.access_token, 'snapshot')).error, false);

  const clients = (await admin('GET', '/api/clients')).json.oauth;
  assert.deepEqual(clients.find((c: any) => c.id === client_id).scopes.split(',').sort(), ['global', 'profile:other', 'profile:shop']);

  // Purge: only clients older than 24 h with no grant at all.
  const db = new DatabaseSync(dbFile());
  try {
    db.prepare('UPDATE oauthClient SET createdAt = ?').run(new Date(Date.now() - 2 * 86400_000).toISOString());
    assert.equal(purgeClients(db), 2, 'abandoned + evil');
    assert.deepEqual((db.prepare('SELECT clientId FROM oauthClient').all() as { clientId: string }[]).map((r) => r.clientId), [client_id]);
  } finally { db.close(); }
  assert.notEqual(abandoned, client_id);

  // Revoking the client from the admin kills its tokens.
  assert.equal((await admin('POST', `/api/clients/${encodeURIComponent(client_id)}/revoke`, { body: {} })).status, 200);
  assert.equal(await mcpStatus({ authorization: `Bearer ${next.access_token}` }), 401);
  assert.equal(await mcpStatus({ authorization: `Bearer ${otherToken}` }), 401);
  assert.equal((await refresh(next.refresh_token)).status >= 400, true);
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
});

test('deleting a profile removes its computer, volume, keys and grants', async () => {
  const scoped = () => dump().match(/profile:(shop|other)\b/g) ?? [];
  assert.ok(scoped().length > 0);
  for (const id of ['shop', 'other']) assert.equal((await admin('POST', `/api/computers/${id}/delete`, { body: {} })).status, 200);
  assert.deepEqual(calls('remove'), [{ op: 'remove', id: 'shop', keepVolume: false }, { op: 'remove', id: 'other', keepVolume: false }]);
  assert.equal(await mcpStatus({ authorization: `Bearer ${tokens.shop}` }), 401, 'key of a deleted profile');
  assert.equal((await admin('GET', '/api/computers/shop')).status, 404);
  assert.deepEqual(scoped(), [], 'no key, token or consent left for the deleted profiles');
});

test('restart reconnects running computers of known profiles only', async () => {
  const id = parseProfileId('shop2')!;
  assert.equal((await admin('POST', '/api/profiles', { body: { id, allow: ['example.com'] } })).status, 201);
  fake.computers.set(id, { id, running: true });
  fake.computers.set('ghost', { id: 'ghost', running: true });
  await restart();
  assert.deepEqual(fake.calls, [{ op: 'list' }, { op: 'list' }, { op: 'ensure', id: 'shop2' }], 'the runner counts before ensure');
  assert.equal(fake.computers.get(id)!.running, true, 'graceful close left the computer running');
});

test('a lease survives a gateway restart', async () => {
  const leased = await call(tokens.global, 'lease_profile', { profile: 'shop2', minutes: 5 });
  assert.ok(!leased.error, leased.text);
  const { lease } = JSON.parse(leased.text);
  assert.ok(!rawDb().includes(lease), 'lease stored as a hash');
  await restart();
  assert.match((await call(tokens.global, 'lease_profile', { profile: 'shop2' })).text, /already leased/);
  const viaLease = await call(tokens.global, 'open', { lease, url: 'https://example.com/' });
  assert.ok(!viaLease.error, viaLease.text);
  assert.deepEqual(JSON.parse((await call(tokens.global, 'release_profile', { lease })).text), { released: true });
});

test('MAX_COMPUTERS: the runner refusal reaches the agent, no computer starts', async () => {
  const id = parseProfileId('shop3')!;
  assert.equal((await admin('POST', '/api/profiles', { body: { id, allow: ['example.com'] } })).status, 201);
  const running = [...fake.computers.values()].filter((c) => c.running).length;
  runner.close();
  runner = await serveRunner(fake, runnerSock, { maxComputers: running });
  try {
    const { lease } = JSON.parse((await call(tokens.global, 'lease_profile', { profile: id })).text);
    const r = await call(tokens.global, 'open', { lease, url: 'https://example.com/' });
    assert.deepEqual(r, { error: true, text: `Too many computers running (MAX_COMPUTERS=${running})` });
    assert.equal(fake.computers.has(id), false);
    await call(tokens.global, 'release_profile', { lease });
  } finally { runner.close(); runner = await serveRunner(fake, runnerSock); }
});

test('client IP (rate limits, API key last IP): Cf-Connecting-IP is ignored unless TRUST_PROXY=cloudflare', async () => {
  const register = (ip: string) => fetch(base + '/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }) });
  // Direct clients: a fresh fake IP per call does not escape the 5 per minute per IP rule (keyed on the socket).
  const direct = [];
  for (let i = 0; i < 6; i++) direct.push((await register(`203.0.113.${i + 1}`)).status);
  assert.ok(direct.includes(429), direct.join());
  // An API key's last IP: the same normalized address.
  const lastIp = async () => (await admin('GET', '/api/clients')).json.keys.find((k: any) => k.name === 'orchestrator').lastIp;
  await mcpStatus({ authorization: `Bearer ${tokens.global}`, 'cf-connecting-ip': '203.0.113.9' });
  assert.match(await lastIp(), /^(::ffff:)?127\.0\.0\.1$/);
  // Behind the tunnel (the listener is reachable through cloudflared only), Cloudflare's header is the client.
  await restart({ TRUST_PROXY: 'cloudflare' });
  for (let i = 0; i < 6; i++) assert.equal((await register(`203.0.113.${i + 101}`)).status, 201, `client ${i + 1}`);
  await mcpStatus({ authorization: `Bearer ${tokens.global}`, 'cf-connecting-ip': '203.0.113.9' });
  assert.equal(await lastIp(), '203.0.113.9');
});

/** Runs fn on a second connection to the gateway database (tests reach under the API: age a step-up, reset rate limits). */
function sql(fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(dbFile());
  try { fn(db); } finally { db.close(); }
}
const wrong = () => String((Number(totp(owner.uri)) + 1) % 1e6).padStart(6, '0');

test('step-up: sensitive admin actions need a 2FA code from the last 15 minutes; 5 bad codes sign out', async () => {
  sql((db) => db.exec('DELETE FROM rateLimit'));
  const left = async () => (await admin('GET', '/api/session')).json.stepUpRemainingS;
  // Re-sign-in: the TOTP step counts as a step-up.
  const half = await admin('POST', '/api/auth/sign-in/email', { body: { email: owner.email, password: owner.password }, headers: adminOrigin() });
  const ok = await admin('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(owner.uri) }, headers: { ...adminOrigin(), cookie: jar(half.cookies) } });
  session = jar(ok.cookies, jar(half.cookies));
  assert.deepEqual((await admin('GET', '/api/session')).json.email, owner.email);
  assert.ok(await left() > 890);
  sql((db) => db.exec('UPDATE step_up SET verified_at = verified_at - 16 * 60000'));
  assert.equal(await left(), 0);
  const sensitive: [string, unknown][] = [
    ['/api/keys', { name: 'k', scope: 'global', expiresIn: '30d' }], ['/api/keys/x/revoke', {}], ['/api/clients/x/revoke', {}],
    ['/api/computers/shop3/config', { allow: ['example.com'] }], ['/api/computers/shop3/login-save', { site: 's', url: 'https://example.com/', username: 'u', password: 'synthetic' }],
    ['/api/computers/shop3/login-delete', { site: 's' }], ['/api/computers/shop3/delete', {}],
  ];
  for (const [path, body] of sensitive) assert.deepEqual((await admin('POST', path, { body })).json, { stepUp: true, error: 'Confirm with a 2FA code first' }, path);
  assert.equal((await admin('GET', '/api/computers/shop3')).status, 200, 'nothing deleted');
  // The rest of the admin still works.
  assert.equal((await admin('GET', '/api/computers')).status, 200);
  assert.equal((await admin('POST', '/api/computers/shop3/release', { body: {} })).status, 200);

  assert.equal((await admin('POST', '/api/step-up', { body: {} })).status, 400);
  const bad = await admin('POST', '/api/step-up', { body: { code: wrong() } });
  assert.deepEqual([bad.status, bad.json], [401, { stepUp: true, error: 'Invalid code' }]);
  const used = owner.backup.shift()!;
  assert.equal((await admin('POST', '/api/step-up', { body: { backupCode: used } })).status, 200, 'backup code works for step-up');
  assert.equal((await admin('POST', '/api/step-up', { body: { backupCode: used } })).status, 401, 'one use only');
  const up = await admin('POST', '/api/step-up', { body: { code: totp(owner.uri) } });
  assert.equal(up.status, 200);
  assert.ok(up.json.stepUpRemainingS > 890);
  assert.equal((await admin('POST', '/api/computers/shop3/config', { body: { allow: ['example.com'] } })).status, 200);

  // Rate limited: 5 tries per minute per IP and endpoint (3 bad, 1 good, 1 bad, then refused).
  sql((db) => db.exec('DELETE FROM rateLimit'));
  const tries = [];
  for (const code of [wrong(), wrong(), wrong(), totp(owner.uri), wrong(), totp(owner.uri)]) tries.push((await admin('POST', '/api/step-up', { body: { code } })).status);
  assert.deepEqual(tries, [401, 401, 401, 200, 401, 429]);
  // A stolen session cookie cannot brute-force the step-up: the 5th bad code in a row ends the session.
  sql((db) => db.exec('DELETE FROM rateLimit'));
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await admin('POST', '/api/step-up', { body: { code: wrong() } })).json.error);
  assert.deepEqual(codes, ['Invalid code', 'Invalid code', 'Invalid code', 'Sign in first'], 'one bad code left over from above');
  assert.equal((await admin('GET', '/api/computers')).status, 401);
  sql((db) => db.exec('DELETE FROM rateLimit'));
});

test('trusted device: skips TOTP on the admin port for 30 days, never on the public listener', async () => {
  const signIn = (cookie = '') => admin('POST', '/api/auth/sign-in/email', { body: { email: owner.email, password: owner.password }, headers: { ...adminOrigin(), cookie } });
  const half = await signIn();
  const ok = await admin('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(owner.uri), trustDevice: true }, headers: { ...adminOrigin(), cookie: jar(half.cookies) } });
  const trust = ok.cookies.find((c) => /^better-auth\.trust_device=/.test(c))!;
  assert.match(trust, /Max-Age=2592000/i);
  assert.doesNotMatch(trust, /Domain=/i, 'host-only: the admin host, never the public one');
  const trusted = jar([trust]);
  // Admin port: password only, straight to a session, but no step-up.
  const direct = await signIn(trusted);
  assert.equal(direct.status, 200);
  assert.notEqual(direct.json.twoFactorRedirect, true);
  session = jar(direct.cookies);
  assert.equal((await admin('GET', '/api/computers')).status, 200);
  assert.equal((await admin('GET', '/api/session')).json.stepUpRemainingS, 0);
  assert.equal((await admin('POST', '/api/computers/shop3/delete', { body: {} })).json.stepUp, true);
  // Sign-in rotates the trust cookie; the fresh one is still dropped on the public listener.
  const rotated = jar([direct.cookies.find((c) => /^better-auth\.trust_device=/.test(c))!]);
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie: rotated },
    body: new URLSearchParams({ email: owner.email, password: owner.password, oauth_query: '' }) });
  assert.match(await login.text(), /Two-factor code/);
  sql((db) => db.exec('DELETE FROM rateLimit'));
});

test('https PUBLIC_URL: the admin port (http, localhost) gets plain cookies and a working session', async () => {
  await restart({ PUBLIC_URL: 'https://arb.example.test' });
  session = '';
  const half = await admin('POST', '/api/auth/sign-in/email', { body: { email: owner.email, password: owner.password }, headers: adminOrigin() });
  assert.equal(half.status, 200);
  const ok = await admin('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(owner.uri) }, headers: { ...adminOrigin(), cookie: jar(half.cookies) } });
  assert.equal(ok.status, 200);
  const all = [...half.cookies, ...ok.cookies];
  assert.ok(all.length > 0);
  for (const c of all) assert.ok(!/^__Secure-|;\s*secure/i.test(c), c);
  session = jar(ok.cookies, jar(half.cookies));
  assert.equal((await admin('GET', '/api/computers')).status, 200);
});
