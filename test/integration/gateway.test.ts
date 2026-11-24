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
import { AB_FLAGS, HIT } from '../../src/runner/protocol.ts';
import { limits } from '../../src/mcp/steps.ts';
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
  }, async () => answers.shift()!()), 0);
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

async function signInNewUser(email: string) {
  sql((db) => db.exec('DELETE FROM rateLimit'));
  const password = randomBytes(12).toString('base64url');
  let uri = '';
  const answers = [() => password, () => totp(uri)];
  assert.equal(await main(['user', 'create', email], env(), (line) => {
    if (line.startsWith('otpauth://')) uri = line;
  }, async () => answers.shift()!()), 0);
  const half = await admin('POST', '/api/auth/sign-in/email', { body: { email, password }, headers: adminOrigin() });
  assert.equal(half.status, 200);
  const ok = await admin('POST', '/api/auth/two-factor/verify-totp', {
    body: { code: totp(uri) }, headers: { ...adminOrigin(), cookie: jar(half.cookies) },
  });
  assert.equal(ok.status, 200);
  return { cookie: jar(ok.cookies, jar(half.cookies)) };
}

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
  assert.deepEqual(names, ['back', 'click', 'fill', 'get_text', 'handoff_status', 'login', 'open', 'playbook', 'press', 'request_human', 'run_playbook', 'run_steps', 'screenshot', 'snapshot']);
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

test('get_text and snapshot: selector, scope and compact reach agent-browser; contains and max_chars cut in the gateway', async () => {
  const sent = () => calls('exec').map((c) => c.argv!.slice(AB_FLAGS.length + 1));
  fake.calls = [];
  const env = /^<untrusted_page_content origin="https:\/\/example.com">\n(.*)\n<\/untrusted_page_content>\n[^\n]*(?:\n(.*))?$/s;
  const parse = (t: string) => { const m = t.match(env)!; return { text: m[1], meta: m[2] && JSON.parse(m[2]) }; };
  const schema = await mcp(tokens.shop, async (c) => (await c.listTools()).tools.find((t) => t.name === 'get_text')!.inputSchema);
  assert.deepEqual(Object.keys(schema.properties!).sort(), ['contains', 'context', 'max_chars', 'ref', 'selector']);

  assert.deepEqual(parse((await call(tokens.shop, 'get_text')).text), { text: 'hello', meta: undefined });
  assert.deepEqual(parse((await call(tokens.shop, 'get_text', { selector: '#usage', max_chars: 2 })).text),
    { text: 'he', meta: { truncated: true, total_chars: 5 } });
  assert.deepEqual(parse((await call(tokens.shop, 'get_text', { ref: 'e4', contains: 'HELL', context: 0 })).text), { text: 'hello', meta: { matches: 1 } });
  assert.deepEqual(parse((await call(tokens.shop, 'get_text', { contains: 'nowhere' })).text), { text: '', meta: { matches: 0 } });
  await call(tokens.shop, 'snapshot');
  assert.deepEqual(parse((await call(tokens.shop, 'snapshot', { scope: '#usage', compact: false, max_chars: 8 })).text),
    { text: '- button', meta: { truncated: true, total_chars: 22 } });
  await call(tokens.shop, 'snapshot', { scope: 'main form' });
  assert.deepEqual(sent(), [
    ['get', 'text', 'body'], ['get', 'text', '#usage'], ['get', 'text', '@e4'], ['get', 'text', 'body'],
    ['snapshot', '-i', '-c'], ['snapshot', '-i', '-s', '#usage'], ['snapshot', '-i', '-c', '-s', 'main form'],
  ]);

  fake.calls = [];
  for (const args of [{ ref: '@e1', selector: 'body' }, { selector: '--json' }, { max_chars: 50_001 }, { context: 11 }]) {
    const r = await call(tokens.shop, 'get_text', args);
    assert.ok(r.error, JSON.stringify(args));
    assert.match(r.text, /validation/i);
  }
  assert.match((await call(tokens.shop, 'get_text', { ref: '@e1', selector: 'body' })).text, /ref or selector, not both/);
  assert.ok((await call(tokens.shop, 'snapshot', { scope: '-s' })).error);
  assert.match((await call(tokens.shop, 'snapshot', { scope: '@e3' })).text, /CSS selector, not a ref/);
  assert.equal(calls('exec').length, 0, 'invalid arguments never reach the host');
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
  assert.deepEqual(details.json.logins, [{ site: 'main', url: 'https://example.com/login', username: 'fixture', lastTestedAt: null, lastResult: null }]);

  // Admin "test": same fill path as the agent's tool, result stored, password never echoed.
  const test = (site: string) => admin('POST', '/api/computers/shop/login-test', { body: { site } });
  const result = async () => (await admin('GET', '/api/computers/shop')).json.logins[0];
  assert.equal((await test('other')).status, 404);
  const { lease } = JSON.parse((await call(tokens.global, 'lease_profile', { profile: 'shop' })).text);
  assert.ok(lease);
  assert.equal((await test('main')).status, 409, 'refused while an agent holds the lease');
  assert.equal((await admin('POST', '/api/computers/shop/release', { body: {} })).status, 200);
  const ok = await test('main');
  assert.deepEqual([ok.status, ok.json], [200, { ok: true, url: 'https://example.com/' }]);
  assert.equal(agentBrowser('--password-stdin').at(-1)!.stdin, password, 'filled like the agent tool');
  assert.equal(agentBrowser('delete').length, 2, 'vault entry deleted after the test too');
  const tested = await result();
  assert.equal(tested.lastResult, 'ok');
  assert.ok(Math.abs(Date.parse(tested.lastTestedAt) - Date.now()) < 5000);
  fake.failOn = 'auth login';
  try {
    const fail = await test('main');
    assert.deepEqual([fail.status, fail.json], [200, { ok: false, url: 'https://example.com/' }]);
  } finally { fake.failOn = ''; }
  assert.equal((await result()).lastResult, 'fail');
  assert.equal(agentBrowser('delete').length, 3, 'vault entry deleted on failure');
  // Takeover fill: the page already open (fake: https://example.com/), never navigated, only on the login's origin.
  const fill = (site: string) => admin('POST', '/api/computers/shop/login-fill', { body: { site } });
  assert.equal((await fill('other')).status, 404);
  const filled = await fill('main');
  assert.deepEqual([filled.status, filled.json], [200, { ok: true, url: 'https://example.com/' }]);
  assert.deepEqual(agentBrowser('--no-navigate').at(-1)!.argv!.slice(-3), ['login', 'gw-main', '--no-navigate']);
  assert.equal(agentBrowser('delete').length, 4, 'vault entry deleted after the fill');
  assert.equal((await result()).lastResult, 'fail', 'a fill is not a test');
  assert.equal((await admin('POST', '/api/computers/shop/login-save',
    { body: { site: 'sub', url: 'https://app.example.com/login', username: 'fixture', password } })).status, 200);
  const saved = agentBrowser('--password-stdin').length;
  const wrong = await fill('sub');
  assert.deepEqual([wrong.status, wrong.json], [200, { ok: false, reason: 'origin', url: 'https://example.com/' }]);
  assert.equal(agentBrowser('--password-stdin').length, saved, 'wrong origin: password never sent to the browser');
  fake.failOn = 'auth login';
  try { assert.deepEqual((await fill('main')).json, { ok: false, reason: 'form', url: 'https://example.com/' }); } finally { fake.failOn = ''; }
  assert.equal((await admin('POST', '/api/computers/shop/login-delete', { body: { site: 'sub' } })).status, 200);
  assert.equal((await admin('POST', '/api/computers/shop/login-save',
    { body: { site: 'main', url: 'https://example.com/login', username: 'fixture', password } })).status, 200);
  assert.deepEqual([(await result()).lastTestedAt, (await result()).lastResult], [null, null], 're-save clears the result');

  assert.ok(!dump().includes(password) && !rawDb().includes(password), 'database');
  assert.ok(!readFileSync(f.audit, 'utf8').includes(password), 'audit');
  assert.ok(!JSON.stringify(details.json).includes(password));
});

test('custom headers: admin saves them (names listed, values never), open and login of that origin send them', async () => {
  const value = randomBytes(12).toString('hex'), json = JSON.stringify({ 'x-bypass': value });
  const save = (body: object) => admin('POST', '/api/computers/shop/header-save', { body });
  assert.equal((await save({ origin: 'https://example.org', name: 'x-bypass', value })).status, 400, 'off the allowlist');
  assert.equal((await save({ origin: 'https://example.com', name: 'Host', value })).status, 400, 'reserved');
  const saved = await save({ origin: 'https://example.com/', name: 'X-Bypass', value });
  assert.deepEqual([saved.status, saved.json], [200, { saved: { origin: 'https://example.com', name: 'x-bypass' } }]);
  const details = await admin('GET', '/api/computers/shop');
  assert.deepEqual(details.json.headers, [{ origin: 'https://example.com', name: 'x-bypass' }]);

  fake.calls = [];
  const sent = () => calls('exec').map((c) => c.argv!.slice(AB_FLAGS.length + 1)).filter((a) => a[0] !== 'wait');
  await call(tokens.shop, 'open', { url: 'https://example.com/a' });
  await call(tokens.shop, 'open', { url: 'https://www.example.com/' });
  assert.deepEqual(sent(), [['open', 'https://example.com/a', '--headers', json], ['open', 'https://www.example.com/']], 'only that origin');
  // auth login navigates without them: the gateway opens the login page first, then fills it in place.
  fake.calls = [];
  const r = await call(tokens.shop, 'login', { site: 'main' });
  assert.ok(!r.error, r.text);
  assert.deepEqual(sent().filter((a) => a[0] === 'open' || a[1] === 'login'),
    [['open', 'https://example.com/login', '--headers', json], ['auth', 'login', 'gw-main', '--no-navigate']]);

  const del = (name: string) => admin('POST', '/api/computers/shop/header-delete', { body: { origin: 'https://example.com', name } });
  assert.deepEqual((await del('X-Bypass')).json, { deleted: 'x-bypass' });
  assert.equal((await del('x-bypass')).status, 404);
  fake.calls = [];
  await call(tokens.shop, 'open', { url: 'https://example.com/a' });
  assert.deepEqual(sent(), [['open', 'https://example.com/a']]);

  assert.ok(!JSON.stringify(details.json).includes(value), 'admin API');
  assert.ok(!readFileSync(f.audit, 'utf8').includes(value), 'audit');
  assert.ok(!rawDb().includes(value), 'database');
});

test('takeover clipboard: paste inserts text, leading dashes never read as flags; copy reads the selection', async () => {
  const paste = (text: unknown) => admin('POST', '/api/computers/shop/paste', { body: { text } });
  for (const bad of ['', 'x'.repeat(5001), 42]) assert.equal((await paste(bad)).status, 400, String(bad).slice(0, 10));
  const before = agentBrowser('inserttext').length;
  assert.equal((await paste('--json x\ny')).status, 200);
  assert.deepEqual(agentBrowser('inserttext').slice(before).map((c) => c.argv!.at(-1)), ['-', '-', 'json x\ny']);
  const copy = await admin('POST', '/api/computers/shop/copy', { body: {} });
  assert.deepEqual([copy.status, copy.json], [200, { text: '' }]);
});

test('run_steps: one call for a known path; first failure stops it with failed_at and the page; budget; allowlist; audit', async () => {
  const sent = () => calls('exec').map((c) => c.argv!.slice(AB_FLAGS.length + 1));
  const audited = () => { const { tool, ok, steps, failed_at } = JSON.parse(readFileSync(f.audit, 'utf8').trim().split('\n').at(-1)!); return { tool, ok, steps, failed_at }; };
  const run = async (steps: unknown[]) => { const r = await call(tokens.shop, 'run_steps', { steps }); return { ...r, head: JSON.parse(r.text.split('\n')[0]) }; };
  const envelopes = (t: string) => t.match(/<untrusted_page_content /g)?.length ?? 0;
  const secret = 'fill-value-' + randomBytes(6).toString('hex');

  // Outputs: the last one, plus those marked keep, each tagged with its step.
  fake.calls = [];
  const r = await run([{ open: 'https://example.com/' }, { get_text: { selector: '#a' }, keep: true }, { fill: { label: 'Email' }, value: secret },
    { click: { role: 'button', name: 'Go', exact: true } }, { wait: { load: 'networkidle' } }, { get_text: {} }, { snapshot: { max_chars: 8 } }]);
  assert.ok(!r.error, r.text);
  assert.equal(r.head.ok, true);
  assert.equal(envelopes(r.text), 2, 'step 5 is neither kept nor last');
  assert.match(r.text, /\nhello\n<\/untrusted_page_content>\n[^\n]+\n\{"step":1\}\n/);
  assert.match(r.text, /\n- button\n<\/untrusted_page_content>\n[^\n]+\n\{"step":6,"truncated":true,"total_chars":22\}$/);
  const wait = sent()[4];
  assert.ok(+wait.at(-1)! > 16_000 && +wait.at(-1)! <= 17_500, 'the wait ends itself before the budget: ' + wait.at(-1));
  assert.deepEqual(sent(), [['open', 'https://example.com/'], ['get', 'text', '#a'], ['find', 'label', 'Email', 'fill', secret],
    ['find', 'role', 'button', 'click', '--name', 'Go', '--exact'], ['wait', '--load', 'networkidle', '--timeout', wait.at(-1)],
    ['get', 'text', 'body'], ['snapshot', '-i', '-c']]);
  assert.deepEqual(audited(), { tool: 'run_steps', ok: true, steps: 7, failed_at: undefined });

  // First failure: later steps never run; agent-browser's message and a snapshot go in the envelope.
  fake.calls = [];
  fake.failOn = 'find';
  try {
    const x = await run([{ open: 'https://example.com/' }, { wait: { ms: 100 } }, { click: { text: 'Sign in' } }, { get_text: {} }]);
    assert.ok(x.error);
    assert.deepEqual({ ...x.head, ms: 0 }, { ok: false, failed_at: 2, error: 'step failed', ms: 0 });
    assert.match(x.text, /<untrusted_page_content origin="https:\/\/example.com">\nError: fake failure\n\n- button "OK" \[ref=e1\]\n<\/untrusted_page_content>\n[^\n]+\n\{"step":2\}$/);
    assert.deepEqual(sent().slice(2), [['find', 'text', 'Sign in', 'click'], ['snapshot', '-i', '-c']]);
  } finally { fake.failOn = ''; }
  assert.deepEqual(audited(), { tool: 'run_steps', ok: false, steps: 4, failed_at: 2 });

  // open outside the allowlist: refused before the host, like the open tool.
  fake.calls = [];
  const off = await run([{ snapshot: {} }, { open: 'https://example.org/' }]);
  assert.deepEqual([off.head.failed_at, off.head.error], [1, 'Domain not allowed. Allowed: example.com']);
  assert.equal(agentBrowser('open').length, 0);

  // login if_needed: skipped without a password field; otherwise the saved login (password through stdin only).
  fake.calls = [];
  fake.passwordFields = 0;
  try { assert.equal((await run([{ login: 'main', if_needed: true }, { snapshot: {} }])).head.ok, true); } finally { fake.passwordFields = 1; }
  assert.deepEqual(sent(), [['get', 'count', 'input[type=password]'], ['snapshot', '-i', '-c']]);
  assert.equal((await run([{ login: 'main', if_needed: true }])).head.ok, true);
  assert.equal((await run([{ login: 'main' }])).head.ok, true);
  assert.equal(agentBrowser('--password-stdin').length, 2);
  assert.match((await run([{ login: 'nope' }])).head.error, /^Unknown site/);

  // Budget: a step that hangs is cut when the budget runs out; a step with under 1 s left is not started.
  limits.budgetMs = 1500;
  fake.slow = 'wait';
  try {
    const t0 = Date.now();
    const b = await run([{ wait: { text: 'never' } }, { snapshot: {} }]);
    assert.deepEqual([b.error, b.head.failed_at, b.head.error], [true, 0, 'budget']);
    assert.ok(Date.now() - t0 < 4000, 'cut at the budget');
    assert.doesNotMatch(b.text, /Error:/);
    limits.budgetMs = 900;
    fake.calls = [];
    assert.deepEqual((await run([{ back: true }])).head.error, 'budget');
    assert.deepEqual(sent(), [['snapshot', '-i', '-c']], 'only the failure snapshot');
  } finally { limits.budgetMs = 18_000; fake.slow = ''; }

  // Schema: no --fn wait, no unknown step, 20 steps at most (SDK for count, handler for each step); nothing reaches the host.
  fake.calls = [];
  for (const steps of [[{ wait: { fn: 'window.x' } }], [{ screenshot: true }], Array(21).fill({ back: true }), []])
    assert.match((await call(tokens.shop, 'run_steps', { steps })).text, /validation|Invalid steps/i, JSON.stringify(steps).slice(0, 40));
  assert.equal(calls('exec').length, 0);
  assert.ok(!readFileSync(f.audit, 'utf8').includes(secret), 'fill values never in the audit');
});

test('playbooks: admin writes them (step-up, audited without name or body), the agent lists and reads them as-is', async () => {
  const marker = 'synthetic-' + randomBytes(6).toString('hex');
  const body = `# Check the quota\n\n\`\`\`json\n{"steps": [{"open": "https://example.com/{workspace}"}]}\n\`\`\`\n${marker}`;
  const save = (name: unknown, b: unknown) => admin('POST', '/api/computers/shop/playbook-save', { body: { name, body: b } });
  const del = (name: unknown) => admin('POST', '/api/computers/shop/playbook-delete', { body: { name } });
  const desc = async () => (await mcp(tokens.shop, (c) => c.listTools())).tools.find((t) => t.name === 'playbook')!.description!;
  const auditLines = () => readFileSync(f.audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => /playbook/.test(l.tool));

  assert.deepEqual(JSON.parse((await call(tokens.shop, 'playbook')).text), []);
  assert.match(await desc(), /Playbooks: none\.$/);
  for (const [name, b] of [['Bad Name', body], ['x'.repeat(41), body], ['big', 'x'.repeat(20 * 1024 + 1)], ['blank', ' \n'], ['nobody', undefined]])
    assert.equal((await save(name, b)).status, 400, String(name).slice(0, 10));
  const created = await save('check-quota', body + '\nv1');
  assert.deepEqual([created.status, created.json], [200, { saved: 'check-quota', created: true }]);
  assert.deepEqual((await save('check-quota', body)).json, { saved: 'check-quota', created: false });
  assert.equal((await save('a-other', 'Other one')).status, 200);

  // Agent side: list, read (no untrusted envelope: admin-written), unknown name lists the others; names in the description.
  assert.deepEqual(JSON.parse((await call(tokens.shop, 'playbook')).text),
    [{ name: 'a-other', description: 'Other one' }, { name: 'check-quota', description: 'Check the quota' }]);
  assert.deepEqual(await call(tokens.shop, 'playbook', { name: 'check-quota' }), { error: false, text: body });
  assert.deepEqual(await call(tokens.shop, 'playbook', { name: 'nope' }), { error: true, text: 'Unknown playbook. Available: a-other, check-quota' });
  assert.match(await desc(), /Playbooks: a-other, check-quota\.$/);
  assert.equal(auditLines().at(-1).tool, 'playbook', 'agent reads are audited like any tool');

  // run_playbook: the recipe in one call, {placeholders} filled from params; on failure the playbook follows.
  const runPb = (a: Record<string, unknown>) => call(tokens.shop, 'run_playbook', a);
  assert.match((await mcp(tokens.shop, (c) => c.listTools())).tools.find((t) => t.name === 'run_playbook')!.description!,
    /Playbooks: a-other \(Other one\); check-quota \(Check the quota\)\.$/);
  fake.calls = [];
  const ran = await runPb({ name: 'check-quota', params: { workspace: 'w1' } });
  assert.ok(!ran.error, ran.text);
  assert.equal(JSON.parse(ran.text.split('\n')[0]).ok, true);
  assert.deepEqual(agentBrowser('open').map((c) => c.argv!.at(-1)), ['https://example.com/w1']);
  fake.failOn = 'open';
  try {
    const bad = await runPb({ name: 'check-quota', params: { workspace: 'w1' } });
    assert.ok(bad.error);
    assert.match(bad.text, /"failed_at":0/);
    assert.ok(bad.text.endsWith(`Playbook check-quota:\n${body}`), bad.text.slice(-80));
  } finally { fake.failOn = ''; }
  fake.calls = [];
  assert.deepEqual(await runPb({ name: 'check-quota' }), { error: true, text: 'Missing params: workspace' });
  assert.match((await runPb({ name: 'a-other' })).text, /no run_steps recipe/);
  assert.deepEqual(await runPb({ name: 'nope' }), { error: true, text: 'Unknown playbook. Available: a-other, check-quota' });
  assert.equal(calls('exec').length, 0, 'refused before the host');

  const listed = (await admin('GET', '/api/computers/shop')).json.playbooks;
  assert.deepEqual(listed.map((b: any) => [b.name, b.description, b.body]), [['a-other', 'Other one', 'Other one'], ['check-quota', 'Check the quota', body]]);
  assert.ok(Math.abs(Date.parse(listed[1].updated) - Date.now()) < 5000);
  assert.equal((await del('nope')).status, 404);
  assert.deepEqual((await del('a-other')).json, { deleted: 'a-other' });
  assert.deepEqual(auditLines().filter((l) => l.tool.startsWith('admin:')).map(({ agent, tool, ok }) => ({ agent, tool, ok })),
    ['create', 'update', 'create', 'delete'].map((t) => ({ agent: 'shop', tool: `admin:playbook_${t}`, ok: true })), 'one line per change, refused ones not logged');
  const log = readFileSync(f.audit, 'utf8');
  assert.ok(!log.includes(marker) && !log.includes('check-quota'), 'neither body nor name in the audit');
});

test('pb_ tools: a profile token gets one root tool per playbook with a recipe, run like run_playbook', async () => {
  const save = (name: string, b: string) => admin('POST', '/api/computers/shop/playbook-save', { body: { name, body: b } });
  const del = (name: string) => admin('POST', '/api/computers/shop/playbook-delete', { body: { name } });
  const json = (j: string) => `\`\`\`json\n${j}\n\`\`\``;
  const pbTools = async (token = tokens.shop) => (await mcp(token, (c) => c.listTools())).tools.filter((t) => t.name.startsWith('pb_'));
  const extra = ['no-params', 'two-params', 'notes', 'bad-json', 'no-steps'];
  for (const [name, b] of [['no-params', `Open the home\n${json('[{"open": "https://example.com/"}]')}`],
    ['two-params', `# Search\n${json('[{"open": "https://example.com/{ws}"}, {"fill": {"label": "Q"}, "value": "{q} in {ws}"}]')}`],
    ['notes', 'Just notes, {nothing} to run'], ['bad-json', `Bad\n${json('{"steps": [}')}`], ['no-steps', `Empty\n${json('{"steps": []}')}`]])
    assert.equal((await save(name, b)).status, 200, name);

  // Schema: one required string (500 max) per placeholder, in order; description = the playbook's.
  const tools = Object.fromEntries((await pbTools()).map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), ['pb_check_quota', 'pb_no_params', 'pb_two_params'], 'no recipe, invalid JSON, no steps: no tool');
  assert.equal(tools.pb_check_quota.description, 'Check the quota');
  assert.deepEqual(tools.pb_check_quota.inputSchema.required, ['workspace']);
  assert.deepEqual(tools.pb_check_quota.inputSchema.properties, { workspace: { type: 'string', maxLength: 500 } });
  assert.deepEqual([tools.pb_no_params.description, tools.pb_no_params.inputSchema.properties, tools.pb_no_params.inputSchema.required ?? []],
    ['Open the home', {}, []]);
  assert.deepEqual(tools.pb_two_params.inputSchema.required, ['ws', 'q']);
  assert.deepEqual(await pbTools(tokens.global), [], 'global token: run_playbook only');

  // A call runs the recipe exactly like run_playbook: same reply, same audit line (never the name or params).
  fake.calls = [];
  const ran = await call(tokens.shop, 'pb_check_quota', { workspace: 'w2' });
  assert.ok(!ran.error, ran.text);
  assert.equal(JSON.parse(ran.text.split('\n')[0]).ok, true);
  assert.deepEqual(agentBrowser('open').map((c) => c.argv!.at(-1)), ['https://example.com/w2']);
  const last = () => { const { tool, ok, steps, failed_at } = JSON.parse(readFileSync(f.audit, 'utf8').trim().split('\n').at(-1)!); return { tool, ok, steps, failed_at }; };
  assert.deepEqual(last(), { tool: 'run_playbook', ok: true, steps: 1, failed_at: undefined });
  fake.failOn = 'open';
  try {
    const bad = await call(tokens.shop, 'pb_check_quota', { workspace: 'w2' });
    assert.ok(bad.error);
    assert.match(bad.text, /"failed_at":0/);
    assert.match(bad.text, /\n\nPlaybook check-quota:\n# Check the quota/);
    assert.deepEqual(last(), { tool: 'run_playbook', ok: false, steps: 1, failed_at: 0 });
  } finally { fake.failOn = ''; }
  fake.calls = [];
  assert.equal((await call(tokens.shop, 'pb_check_quota', {})).error, true, 'required param');
  assert.equal((await call(tokens.shop, 'pb_two_params', { ws: 'x'.repeat(501), q: 'a' })).error, true, '500 max');
  assert.equal(calls('exec').length, 0, 'refused before the host');
  const log = readFileSync(f.audit, 'utf8');
  assert.ok(!log.includes('check_quota') && !log.includes('w2'), 'neither name nor params in the audit');

  // Collision: a row written around savePlaybook (names are slugs, no "_") maps to the same pb_ name; the later one is skipped.
  sql((db) => db.prepare('INSERT INTO playbooks (profile, name, body, updated) VALUES (?, ?, ?, ?)').run('shop', 'no_params', `Twin\n${json('[{"back": true}]')}`, Date.now()));
  try {
    assert.deepEqual((await pbTools()).filter((t) => t.name === 'pb_no_params').map((t) => t.description), ['Open the home']);
  } finally { sql((db) => db.prepare('DELETE FROM playbooks WHERE name = ?').run('no_params')); }

  // Cap: 20 pb_ tools at most, the first by name; run_playbook still runs the others.
  const many = Array.from({ length: 20 }, (_, i) => `z-${String(i).padStart(2, '0')}`);
  for (const n of many) assert.equal((await save(n, `Many ${n}\n${json('[{"back": true}]')}`)).status, 200);
  const capped = (await pbTools()).map((t) => t.name).sort();
  assert.equal(capped.length, 20);
  assert.deepEqual(capped.slice(-3), ['pb_z_14', 'pb_z_15', 'pb_z_16'], 'by name: z-17 to z-19 left out');
  assert.equal((await call(tokens.shop, 'run_playbook', { name: 'z-19' })).error, false);

  // A pb_ tool from a stale tools/list (playbook deleted since): a clear error, no crash.
  assert.equal((await del('z-00')).status, 200);
  assert.deepEqual(await call(tokens.shop, 'pb_z_00'),
    { error: true, text: 'pb_z_00: no such playbook any more (deleted, renamed or without a recipe). Call playbook for the list.' });
  assert.match((await call(tokens.shop, 'pb_nope_x')).text, /Call playbook for the list/);
  assert.match((await call(tokens.shop, 'nope')).text, /Tool nope not found$/, 'other unknown tools: the SDK error');

  for (const n of [...many.slice(1), ...extra]) assert.equal((await del(n)).status, 200, n);
  assert.deepEqual((await pbTools()).map((t) => t.name), ['pb_check_quota']);
});

test('teach: each admin gesture runs as a semantic step and comes back as one; a password field becomes the saved login', async () => {
  // As the page does: its recording id (rec) on every call, a seq on each gesture that may move the focus, typing after
  // the last one; explicit values in body win. Typed text: teach-focus first (the page sends it on the first character),
  // its refusal drops the text; raw: one call as given.
  let S = 0;
  const fill = (a: string, body: Record<string, unknown>) => {
    const b: Record<string, unknown> = { rec: 'R', ...(a === 'type' || a === 'focus' ? { after: S } : a === 'read' ? {} : { seq: ++S }), ...body };
    if (typeof b.seq === 'number') S = b.seq;
    return b;
  };
  const send = (a: string, b: Record<string, unknown>) => admin('POST', `/api/computers/shop/teach-${a}`, { body: b });
  const raw = (a: string, body: Record<string, unknown>) => send(a, fill(a, body));
  const teach = async (a: string, body: Record<string, unknown>) => {
    const b = fill(a, body);
    if (a === 'type' && b.text !== undefined) {
      const f = await send('focus', { rec: b.rec, after: b.after });
      if (f.status !== 200) return f;
    }
    return send(a, b);
  };
  const abs = () => calls('exec').filter((c) => c.argv![0] === 'agent-browser').map((c) => c.argv!.slice(1 + AB_FLAGS.length));
  const hits = () => calls('exec').filter((c) => c.argv![0] === 'node').map((c) => c.argv!.slice(3));
  const defaults = { ...fake.hit }, root = { role: 'RootWebArea', name: 'Fake page' };
  const secret = 'typed-' + randomBytes(9).toString('hex');
  try {
    let r = await teach('click', { x: 10, y: 20 });
    assert.deepEqual([r.status, r.json], [200, { step: { click: { role: 'button', name: 'OK' } }, field: false }]);
    assert.deepEqual(hits().at(-1), ['at', '10', '20']);
    assert.ok(calls('exec').some((c) => c.argv![2] === HIT), 'the runner let the HIT script through');
    assert.deepEqual(abs().at(-1), ['find', 'role', 'button', 'click', '--name', 'OK']);
    for (const b of [{ x: -1, y: 2 }, { x: 1.5, y: 2 }, { x: '1', y: 2 }, { x: 1 }]) assert.equal((await teach('click', b)).status, 400, JSON.stringify(b));

    fake.hit.at = { url: 'https://example.com/', chain: [{ role: 'generic', name: '' }, root] };
    const n = abs().length;
    r = await teach('click', { x: 1, y: 1 });
    assert.deepEqual([r.status, r.json.error], [422, 'No stable locator matching only this element: try its text or label']);
    assert.equal(abs().length, n, 'nothing clicked');
    // Two buttons named delete: every locator matches both, agent-browser would click the first one.
    fake.hit.at = { url: 'https://example.com/', chain: [{ role: 'button', name: 'Delete', tag: 'button', attr: 'delete', count: 2, exact: 2, names: 2 }, root] };
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 422, 'no locator matching only the clicked element');
    assert.equal(abs().length, n, 'nothing clicked');

    // The failed click left the focus on the previous field: typing (a password) would land there. Refused until a click goes through.
    r = await teach('type', { text: secret });
    assert.deepEqual([r.status, r.json.error], [409, 'The last click or typing did not go through, so the focus may be on another field: click the field again']);
    assert.equal(abs().length, n, 'nothing typed');
    fake.hit.at = defaults.at;
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 200);
    r = await teach('type', { text: 'me@example.test' });
    assert.deepEqual([r.status, r.json], [200, { step: { fill: { role: 'textbox', name: 'Email' }, value: 'me@example.test' } }]);
    assert.deepEqual(abs().at(-1), ['find', 'role', 'textbox', 'fill', 'me@example.test', '--name', 'Email']);
    assert.equal((await teach('type', { text: '-rf' })).status, 400, 'a recipe cannot fill a leading dash');
    assert.equal((await teach('type', { text: 'me' })).status, 409, 'typing off after a failed fill too');
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 200);

    // Password field (type attribute in any case): the saved login of the page's origin is filled instead; the typed text goes nowhere.
    fake.hit.focus = { url: 'https://example.com/login?x=1', chain: [{ role: 'textbox', name: '', tag: 'input', type: 'PassWord' }, root] };
    r = await teach('type', { text: secret });
    assert.deepEqual([r.status, r.json], [200, { step: { login: 'main', if_needed: true } }]);
    assert.deepEqual(abs().at(-3), ['auth', 'login', 'gw-main', '--no-navigate']);
    fake.hit.focus = { url: 'https://www.example.com/', chain: [{ role: 'textbox', name: '', tag: 'input', type: 'password' }, root] };
    assert.equal((await teach('type', { text: secret })).status, 422, 'no saved login for this origin');
    assert.ok(!JSON.stringify(fake.calls).includes(secret) && !readFileSync(f.audit, 'utf8').includes(secret), 'typed password never sent or logged');

    // The page numbers its gestures (seq) and names the one its text follows (after). One the gateway did not run
    // (failed on the way, refused for the lease) means the focus may be on another field: refused, nothing typed.
    const email = defaults.focus as object, MOVED = 'The focus is not on the field you clicked: click the field again';
    let k = abs().length;
    assert.equal((await teach('click', { x: 1, y: 1, seq: 1 })).status, 200);
    assert.deepEqual([(await teach('type', { text: secret, after: 2 })).status, abs().length], [409, k + 1]);
    // A click on a field, then the focus is on another one (a script moved it): refused.
    fake.hit.at = email;
    assert.equal((await teach('click', { x: 1, y: 1, seq: 3 })).json.field, true);
    fake.hit.focus = { url: 'https://example.com/', chain: [{ role: 'textbox', name: 'Name', tag: 'input', count: 1, exact: 1 }, root] };
    k = abs().length;
    r = await teach('type', { text: secret, after: 3 });
    assert.deepEqual([r.status, r.json.error, abs().length], [409, MOVED, k]);
    // Same field: filled.
    assert.equal((await teach('click', { x: 1, y: 1, seq: 4 })).status, 200);
    fake.hit.focus = email;
    r = await teach('type', { text: 'me', after: 4 });
    assert.deepEqual([r.status, r.json], [200, { step: { fill: { role: 'textbox', name: 'Email' }, value: 'me' } }]);
    // Another recording (a second admin tab) numbers its gestures from 1 too: its click makes this one's text stale.
    assert.equal((await teach('click', { x: 1, y: 1, seq: 4, rec: 'R2' })).status, 200);
    k = abs().length;
    assert.deepEqual([(await teach('type', { text: secret, after: 4 })).status, abs().length], [409, k]);
    assert.equal((await teach('type', { text: secret, after: 4, rec: undefined })).status, 409, 'no recording id: refused');
    assert.equal((await teach('click', { x: 1, y: 1, seq: 4 })).status, 200);
    // The live element is a password input (its type property, through shadow roots), whatever the AX chain says: the login.
    fake.hit.focus = { url: 'https://example.com/login', chain: [{ role: 'textbox', name: 'Password', tag: 'input', count: 1, exact: 1 }, root], live: 'password' };
    r = await teach('type', { text: secret, after: 4 });
    assert.deepEqual([r.status, r.json], [200, { step: { login: 'main', if_needed: true } }]);
    // The login submitted and the next page focused another field: typing goes there, not refused for the clicked one.
    fake.hit.focus = { url: 'https://example.com/home', chain: [{ role: 'textbox', name: 'Name', tag: 'input', count: 1, exact: 1 }, root] };
    r = await teach('type', { text: 'Ada', after: 4 });
    assert.deepEqual([r.status, r.json], [200, { step: { fill: { role: 'textbox', name: 'Name' }, value: 'Ada' } }]);
    fake.hit.focus = { ...email, live: 'frame' };
    assert.equal((await teach('type', { text: secret, after: 4 })).status, 422, 'typing inside a frame: not recorded');

    // Several saved logins for the origin: names and usernames come back for the page to pick, nothing is filled.
    assert.equal((await admin('POST', '/api/computers/shop/login-save',
      { body: { site: 'alt', url: 'https://example.com/alt', username: 'other', password: randomBytes(9).toString('hex') } })).status, 200);
    try {
      fake.hit.at = defaults.at;
      assert.equal((await teach('click', { x: 1, y: 1, seq: 5 })).status, 200);
      fake.hit.focus = { url: 'https://example.com/login', chain: [{ role: 'textbox', name: '', tag: 'input', type: 'password' }, root] };
      k = abs().length;
      r = await teach('type', { text: secret, after: 5 });
      assert.deepEqual([r.status, r.json, abs().length], [200, { pick: [{ site: 'alt', username: 'other' }, { site: 'main', username: 'fixture' }] }, k]);
      r = await teach('type', { login: 'alt', after: 5 });
      assert.deepEqual([r.status, r.json], [200, { step: { login: 'alt', if_needed: true } }]);
      assert.ok(abs().slice(k).some((a) => a.join(' ') === 'auth login gw-alt --no-navigate'), 'the picked login filled');
      assert.equal((await raw('type', { login: 'alt', after: 5 })).status, 409, 'the noted field served its flush');
      assert.equal((await raw('focus', { after: 5 })).status, 200);
      assert.equal((await raw('type', { login: 'nope', after: 5 })).status, 400);
      assert.equal((await teach('click', { x: 1, y: 1, seq: 6 })).status, 200);
      assert.equal((await raw('focus', { after: 6 })).status, 200);
      fake.hit.focus = email;
      assert.deepEqual([(await raw('type', { login: 'alt', after: 6 })).json.error], [MOVED], 'a pick for a field that is no longer a password');
      assert.equal((await teach('click', { x: 1, y: 1, seq: 7 })).status, 200);
      assert.equal((await raw('focus', { after: 7 })).status, 200);
      assert.deepEqual([(await raw('type', { login: 'alt', after: 7 })).json.error], [MOVED], 'a pick for a field that never was a password');
    } finally {
      assert.equal((await admin('POST', '/api/computers/shop/login-delete', { body: { site: 'alt' } })).status, 200);
    }
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 200);

    // Typing is bound to the field focused when it began (teach-focus). A Tab into the password field, typing, then the
    // page refreshes and autofocuses its email field before the flush: refused, nothing filled, the password not echoed.
    const pw = { url: 'https://example.com/login', chain: [{ role: 'textbox', name: '', tag: 'input', type: 'password' }, root] };
    const name = { url: 'https://example.com/', chain: [{ role: 'textbox', name: 'Name', tag: 'input', count: 1, exact: 1 }, root] };
    assert.equal((await teach('press', { key: 'Tab' })).status, 200);
    fake.hit.focus = pw;
    assert.equal((await raw('focus', {})).status, 200);
    fake.hit.focus = email; k = abs().length;
    r = await raw('type', { text: secret });
    assert.deepEqual([r.status, r.json, abs().length], [409, { error: MOVED }, k]);
    // The other way round: typing began in the email field, the focus is now on a password: no login, no fill.
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 200);
    assert.equal((await raw('focus', {})).status, 200);
    fake.hit.focus = pw; k = abs().length;
    assert.deepEqual([(await raw('type', { text: secret })).status, abs().length], [409, k]);
    // Another field than the one typing began in: refused.
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 200);
    fake.hit.focus = email;
    assert.equal((await raw('focus', {})).status, 200);
    fake.hit.focus = name; k = abs().length;
    assert.deepEqual([(await raw('type', { text: secret })).json.error, abs().length], [MOVED, k]);
    // No field noted (a page that skipped teach-focus): refused.
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 200);
    k = abs().length;
    assert.deepEqual([(await raw('type', { text: secret })).status, abs().length], [409, k]);
    // A stale tab's calls (another recording) are refused before any input and leave the active tab's state alone.
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 200);
    fake.hit.focus = email;
    assert.equal((await raw('focus', {})).status, 200);
    assert.equal((await raw('type', { text: secret, rec: 'OLD' })).status, 409);
    assert.equal((await raw('focus', { rec: 'OLD' })).status, 409);
    r = await raw('type', { text: 'me' });
    assert.deepEqual([r.status, r.json], [200, { step: { fill: { role: 'textbox', name: 'Email' }, value: 'me' } }]);
    assert.ok(!JSON.stringify(fake.calls).includes(secret), 'typed password never sent');

    assert.deepEqual((await teach('press', { key: 'Enter' })).json, { step: { press: 'Enter' } });
    assert.equal((await teach('press', { key: 'a' })).status, 400);
    assert.equal((await teach('open', { url: 'https://example.org/' })).status, 400);
    assert.deepEqual((await teach('open', { url: 'https://example.com/usage' })).json, { step: { open: 'https://example.com/usage' } });
    r = await teach('read', { selector: '#usage', contains: 'hell' });
    assert.deepEqual(r.json, { step: { get_text: { selector: '#usage', contains: 'hell' } }, text: 'hello' });
    assert.deepEqual(abs().at(-1), ['get', 'text', '#usage']);
    assert.equal((await teach('read', { selector: '-x' })).status, 400);

    // Replay: the draft as a playbook body, run like run_playbook.
    const body = '# Draft\n```json\n{"steps": [{"open": "https://example.com/{ws}"}, {"get_text": {}}]}\n```';
    r = await teach('replay', { body, params: { ws: 'acme' } });
    assert.equal(r.json.ok, true, r.json.text);
    assert.match(r.json.text, /hello/);
    assert.deepEqual(abs().slice(-2), [['open', 'https://example.com/acme'], ['get', 'text', 'body']]);
    assert.deepEqual([(await teach('replay', { body })).json.error], ['Missing params: ws']);
    assert.equal((await teach('replay', { body: body.replace('example.com', 'example.org'), params: { ws: 'a' } })).json.ok, false, 'allowlist');
    // That replay stopped partway: the focus is wherever it stopped, typing after it is refused.
    k = abs().length;
    assert.deepEqual([(await teach('type', { text: secret })).status, abs().length], [409, k]);

    const audit = readFileSync(f.audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => /teach/.test(l.tool));
    assert.deepEqual([...new Set(audit.map((l) => l.tool))].sort(), ['admin:teach-click', 'admin:teach-focus', 'admin:teach-open', 'admin:teach-press', 'admin:teach-read', 'admin:teach-replay', 'admin:teach-type']);

    // A gesture queued behind another while an agent leases the profile: checked once its turn comes.
    let go!: (v?: unknown) => void;
    fake.hold = new Promise((r) => go = r);
    const h = hits().length, first = teach('click', { x: 1, y: 1 });
    while (hits().length === h) await new Promise((r) => setTimeout(r, 5)); // first one held in HIT
    const queued = teach('click', { x: 1, y: 1 }), m = abs().length;
    await new Promise((r) => setTimeout(r, 50)); // reaches pc.serial before the lease
    const leased = await call(tokens.global, 'lease_profile', { profile: 'shop' });
    assert.ok(!leased.error, leased.text);
    go(); fake.hold = undefined;
    assert.deepEqual([(await first).status, (await queued).status], [200, 409]);
    assert.equal(abs().length, m + 1, 'only the gesture that started before the lease ran');
    assert.equal((await teach('click', { x: 1, y: 1 })).status, 409, 'not while an agent holds it');
    assert.equal((await admin('POST', '/api/computers/shop/release', { body: {} })).status, 200);
    assert.equal((await teach('type', { text: secret })).status, 409, 'a click refused for the lease left the focus: typing off');
  } finally {
    fake.hit = defaults;
    fake.hold = undefined;
  }
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
    ['back', 'click', 'create_profile', 'fill', 'get_text', 'handoff_status', 'lease_profile', 'list_profiles', 'login', 'open', 'playbook', 'press', 'release_profile',
      'request_human', 'run_playbook', 'run_steps', 'screenshot', 'snapshot']);
  assert.match((await call(tokens.global, 'open', { lease: 'arb_l_bogus', url: 'https://example.com/' })).text, /Unknown or expired lease/);
  assert.match((await call(tokens.global, 'lease_profile', { domain: 'example.org' })).text, /No free profile/);

  const leased = await call(tokens.global, 'lease_profile', { domain: 'www.example.com', minutes: 5 });
  assert.ok(!leased.error, leased.text);
  const { lease, profile } = JSON.parse(leased.text);
  assert.equal(profile, 'shop');
  assert.deepEqual(JSON.parse(leased.text).playbooks, [{ name: 'check-quota', description: 'Check the quota' }]);
  assert.match((await call(tokens.global, 'playbook', { lease, name: 'check-quota' })).text, /^# Check the quota/);
  assert.match((await call(tokens.global, 'playbook', { lease: 'arb_l_bogus' })).text, /Unknown or expired lease/);
  assert.match((await mcp(tokens.global, (c) => c.listTools())).tools.find((t) => t.name === 'playbook')!.description!, /Playbooks: those returned by lease_profile\.$/);
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

const upgrade = (headers: Record<string, string>, profile = 'shop') => new Promise<string>((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: ADMIN, path: `/api/computers/${profile}/stream`, headers: {
    host: `127.0.0.1:${ADMIN}`, cookie: session, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
    'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } });
  req.on('upgrade', () => resolve('upgraded'));
  req.on('response', (r) => resolve('http ' + r.statusCode));
  req.on('error', () => resolve('dropped'));
  req.end();
});

test('live view WebSocket: cross-origin upgrade dropped before touching the computer', async () => {
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
  // Browser navigations and form POSTs: Better Auth only redirects those (fetch calls get JSON), so the gateway must
  // cope with their headers. Raw http: Node's fetch forces sec-fetch-mode: cors.
  const nav = (path: string, cookie = '', form?: Record<string, string>, origin = base) => new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...(cookie && { cookie }) };
    if (form) Object.assign(headers, { 'content-type': 'application/x-www-form-urlencoded', ...(origin && { origin }) });
    http.request(new URL(path, base), { method: form ? 'POST' : 'GET', headers }, (r) => {
      let raw = '';
      r.on('data', (d) => { raw += d; });
      r.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(r.headers)) for (const x of [v ?? []].flat()) h.append(k, String(x));
        resolve(new Response(raw, { status: r.statusCode, headers: h }));
      });
    }).on('error', reject).end(form && String(new URLSearchParams(form)));
  });
  const get = (path: string, cookie = '') => nav(path, cookie);
  const postForm = (path: string, form: Record<string, string>, cookie = '', origin = base) => nav(path, cookie, form, origin);
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
  // Not no-referrer: browsers then send `Origin: null` on form POSTs and the same-origin check below refuses them.
  assert.equal(loginPage.headers.get('referrer-policy'), 'same-origin');
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
  const grant = async (scope: string, consentCookie = cookie) => {
    const toConsent = await get('/api/auth/oauth2/authorize?' + authorizeQuery, consentCookie);
    assert.equal(new URL(toConsent.headers.get('location')!, base).pathname, '/consent');
    const cq = queryOf(toConsent);
    const page = await get('/consent?' + cq, consentCookie);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /test client/);
    assert.ok(html.includes('value="' + scope + '"'));
    if (scope === 'global') {
      assert.match(html, /other<\/b><small>Your role: admin/);
      assert.ok(!html.includes('value="profile:private-oauth"'));
      assert.equal((await postForm('/consent', { scope: 'profile:private-oauth', accept: 'true', oauth_query: cq }, consentCookie)).status, 400);
    }
    assert.ok(html.includes(client_id));
    assert.match(html, /Unverified client/);
    assert.match(html, /Registered (just now|\d+ min ago)/);
    assert.match(html, /Loopback: the authorization goes to an app/);
    assert.match(html, /Global \(all my profiles\)<small>Not recommended for an unverified client/);
    assert.equal((await postForm('/consent', { scope: 'profile:nope', accept: 'true', oauth_query: cq }, consentCookie)).status, 400);
    assert.equal((await postForm('/consent', { scope, accept: 'true', oauth_query: cq }, consentCookie, 'http://evil.test')).status, 403);
    let r = await postForm('/consent', { scope, accept: 'true', oauth_query: cq }, consentCookie);
    if (scope === 'global') {
      assert.equal(r.status, 200);
      const warn = await r.text();
      assert.match(warn, /Unverified client with Global access/);
      assert.match(warn, /name="confirm" value="global"/);
      r = await postForm('/consent', { scope, confirm: 'global', accept: 'true', oauth_query: cq }, consentCookie);
    }
    assert.equal(r.status, 200, 'consent answers a page, not a 302 (form-action would block the redirect)');
    const ref = r.headers.get('refresh')!, loc = new URL(ref.slice(ref.indexOf('url=') + 4));
    assert.match(r.headers.get('content-security-policy')!, /form-action 'self'/);
    assert.match(await r.text(), /<a href="http/);
    assert.equal(loc.origin + loc.pathname, redirect_uri);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    return loc.searchParams.get('code')!;
  };
  const token = (form: Record<string, string>) => postForm('/api/auth/oauth2/token', { client_id, resource, ...form }, '', '');
  const exchange = (code: string, verifier = code_verifier) => token({ grant_type: 'authorization_code', redirect_uri, code, code_verifier: verifier });

  const peer = await signInNewUser('oauth-member@example.com');
  assert.equal((await admin('POST', '/api/profiles', { headers: peer, body: { id: 'private-oauth', allow: ['example.com'] } })).status, 201);
  const peerGrant = await (await exchange(await grant('profile:private-oauth', peer.cookie))).json();
  assert.ok(peerGrant.access_token && peerGrant.refresh_token);
  assert.deepEqual((await admin('GET', '/api/clients')).json.oauth, []);

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
  assert.ok(!/Unverified|Not recommended/.test(cimdPage));
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

  // Revoking one user's grants leaves the other user's access, refresh and consent intact.
  assert.equal((await admin('POST', `/api/clients/${encodeURIComponent(client_id)}/revoke`, { body: {} })).status, 200);
  assert.equal(await mcpStatus({ authorization: `Bearer ${next.access_token}` }), 401);
  assert.equal(await mcpStatus({ authorization: `Bearer ${otherToken}` }), 401);
  assert.equal((await refresh(next.refresh_token)).status >= 400, true);
  assert.equal((await admin('POST', `/api/clients/${encodeURIComponent(client_id)}/revoke`, { body: {} })).status, 404);
  assert.deepEqual((await admin('GET', '/api/clients')).json.oauth, []);
  const peerClients = (await admin('GET', '/api/clients', { headers: peer })).json.oauth;
  assert.deepEqual(peerClients.map((c: any) => [c.id, c.scopes]), [[client_id, 'profile:private-oauth']]);
  sql((db) => assert.deepEqual(db.prepare('SELECT referenceId FROM oauthConsent WHERE clientId = ?').all(client_id)
    .map((row) => row.referenceId), ['profile:private-oauth']));
  assert.equal((await call(peerGrant.access_token, 'playbook')).error, false);
  const peerRefresh = await refresh(peerGrant.refresh_token);
  assert.equal(peerRefresh.status, 200);
  const peerAccess = (await peerRefresh.json()).access_token;
  assert.equal((await call(peerAccess, 'playbook')).error, false);
  const members = '/api/computers/private-oauth/members';
  assert.equal((await admin('POST', members, { headers: peer, body: { email: owner.email, role: 'admin' } })).status, 200);
  assert.equal((await admin('POST', members, { body: { email: 'oauth-member@example.com', role: null } })).status, 200);
  assert.equal(await mcpStatus({ authorization: `Bearer ${peerAccess}` }), 401);
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
});

const DONE_NEXT = 'Browser tools work again. Take a snapshot: the page may have changed.';

test('handoff: request_human pauses the agent until the admin ends it; paste and login-fill only once taken', async () => {
  const { lease } = JSON.parse((await call(tokens.global, 'lease_profile', { profile: 'shop', minutes: 5 })).text);
  const ask = (args: Record<string, unknown>) => call(tokens.global, 'request_human', { lease, ...args });
  const status = (wait_s = 0) => call(tokens.global, 'handoff_status', { lease, wait_s });
  const act = (a: string, body: object = {}) => admin('POST', `/api/computers/shop/${a}`, { body });
  const row = async () => (await admin('GET', '/api/computers')).json.find((c: any) => c.id === 'shop');
  assert.deepEqual(JSON.parse((await status()).text), { state: 'none' });
  assert.equal((await act('handoff-take')).status, 409);
  fake.computers.get('shop')!.running = false;
  assert.deepEqual(await ask({ reason: 'x' }), { error: true, text: 'Open a page first: the browser is not running' });
  fake.computers.get('shop')!.running = true;

  const r = await ask({ reason: 'Solve\u0007 the   captcha\u202e please' });
  assert.ok(!r.error, r.text);
  const h = JSON.parse(r.text);
  assert.match(h.handoff, /^h_[\w-]{16}$/);
  assert.equal(h.state, 'pending');
  assert.equal(h.url, `http://localhost:${ADMIN}/#/handoff/${h.handoff}`);
  assert.match((await ask({ reason: 'again' })).text, /already open/);
  assert.deepEqual(await call(tokens.global, 'open', { lease, url: 'https://example.com/' }),
    { error: true, text: `Waiting for a human (${h.handoff}) until ${h.deadline}. Call handoff_status.` });
  assert.equal((await call(tokens.global, 'playbook', { lease, name: 'check-quota' })).error, false, 'playbooks are not paused');
  const listed = (await row()).handoff;
  assert.deepEqual({ ...listed, created: 0 }, { id: h.handoff, state: 'pending', reason: 'Solve the captcha please', created: 0, deadline: h.deadline });
  assert.equal(JSON.parse((await status()).text).url, h.url);

  assert.equal((await act('paste', { text: 'x' })).status, 409);
  assert.equal((await act('login-fill', { site: 'main' })).status, 409);
  assert.equal((await act('handoff-fail')).status, 400, 'note required');
  assert.equal((await act('handoff-done', { note: 'x'.repeat(1001) })).status, 400);
  assert.deepEqual((await act('handoff-take')).json, { state: 'taken' });
  assert.equal((await act('paste', { text: 'x' })).status, 200);
  assert.equal((await act('login-fill', { site: 'main' })).status, 200);

  const t0 = Date.now();
  const [st, done] = await Promise.all([status(5), new Promise((ok) => setTimeout(ok, 300)).then(() => act('handoff-done', { note: 'Captcha solved' }))]);
  assert.equal(done.status, 200);
  assert.ok(Date.now() - t0 < 4500, 'long-poll returns before wait_s');
  assert.deepEqual(JSON.parse(st.text), { handoff: h.handoff, state: 'done', note: 'Captcha solved', next: DONE_NEXT }, 'no url once ended');
  assert.equal((await act('paste', { text: 'x' })).status, 409, 'the agent drives again');
  assert.equal((await call(tokens.global, 'open', { lease, url: 'https://example.com/' })).error, false);

  // release_profile cancels an open request.
  assert.equal((await ask({ reason: 'again' })).error, false);
  assert.deepEqual(JSON.parse((await call(tokens.global, 'release_profile', { lease })).text), { released: true });
  assert.equal((await row()).handoff, null);
  assert.ok(readFileSync(f.audit, 'utf8').includes('"tool":"handoff:cancelled"'));

  // Profile key: same tools without a lease. Deadline passed -> expired, tools work again.
  const p = JSON.parse((await call(tokens.shop, 'request_human', { reason: '2FA code', minutes: 1 })).text);
  assert.match((await call(tokens.shop, 'open', { url: 'https://example.com/' })).text, /^Waiting for a human/);
  sql((db) => db.prepare('UPDATE handoffs SET deadline = ? WHERE id = ?').run(Date.now() - 1, p.handoff));
  assert.equal(JSON.parse((await call(tokens.shop, 'handoff_status', { wait_s: 0 })).text).state, 'expired');
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
  const q = JSON.parse((await call(tokens.shop, 'request_human', { reason: 'consent screen' })).text);
  assert.equal((await act('handoff-take')).status, 200);
  assert.equal((await act('handoff-fail', { note: 'Wrong account' })).status, 200);
  assert.equal((await act('handoff-fail', { note: 'again' })).status, 409);
  assert.deepEqual(JSON.parse((await call(tokens.shop, 'handoff_status', { wait_s: 0 })).text),
    { handoff: q.handoff, state: 'failed', note: 'Wrong account', next: DONE_NEXT });

  const m = await (await fetch(`http://127.0.0.1:${ADMIN}/metrics`)).text();
  for (const line of ['arb_handoff_total{outcome="done"} 1', 'arb_handoff_seconds_count{outcome="done"} 1', 'arb_handoffs_open 0'])
    assert.ok(m.split('\n').includes(line), line);
  assert.match(m, /^arb_handoff_seconds_sum\{outcome="done"\} \d+(\.\d+)?$/m);
  for (const t of [readFileSync(f.audit, 'utf8'), m]) assert.ok(!/captcha|Wrong account|consent/i.test(t), 'reason and note never in audit or metrics');
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
  const me = (await admin('GET', '/api/session')).json;
  assert.equal(me.email, owner.email);
  assert.equal(me.mcpUrl, `${base}/mcp`, 'MCP URL from PUBLIC_URL, not derived from the admin port');
  assert.ok(await left() > 890);
  sql((db) => db.exec('UPDATE step_up SET verified_at = verified_at - 16 * 60000'));
  assert.equal(await left(), 0);
  const sensitive: [string, unknown][] = [
    ['/api/keys', { name: 'k', scope: 'global', expiresIn: '30d' }], ['/api/keys/x/revoke', {}], ['/api/clients/x/revoke', {}],
    ['/api/computers/shop3/config', { allow: ['example.com'] }], ['/api/computers/shop3/login-save', { site: 's', url: 'https://example.com/', username: 'u', password: 'synthetic' }],
    ['/api/computers/shop3/members', { email: owner.email, role: null }],
    ['/api/computers/shop3/login-delete', { site: 's' }], ['/api/computers/shop3/delete', {}],
    ['/api/computers/shop3/playbook-save', { name: 'p', body: 'x' }], ['/api/computers/shop3/playbook-delete', { name: 'p' }],
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

test('handoff url: PUBLIC_URL base with ADMIN_PUBLIC=1', async () => {
  await restart({ ADMIN_PUBLIC: '1', PUBLIC_URL: 'https://arb.example.test', ACCESS_AUD: 'a'.repeat(64), ACCESS_TEAM: 'team' });
  const { lease } = JSON.parse((await call(tokens.global, 'lease_profile', { profile: 'shop2', minutes: 5 })).text);
  const h = JSON.parse((await call(tokens.global, 'request_human', { lease, reason: 'captcha' })).text);
  assert.equal(h.url, `https://arb.example.test/#/handoff/${h.handoff}`);
  assert.equal((await admin('POST', '/api/computers/shop2/handoff-fail', { body: { note: 'n' } })).status, 200);
  assert.equal(JSON.parse((await call(tokens.global, 'handoff_status', { lease, wait_s: 0 })).text).url, undefined);
  await call(tokens.global, 'release_profile', { lease });
});

test('profile members control API access, including for a gateway admin', async () => {
  const email = 'member@example.com', headers = await signInNewUser(email);
  const id = 'private', path = '/api/computers/' + id, roster = path + '/members';
  const setRole = (role: string | null, target = owner.email) => admin('POST', roster, { headers, body: { email: target, role } });
  const listed = async () => (await admin('GET', '/api/computers')).json.find((item: any) => item.id === id);
  assert.equal((await admin('POST', '/api/profiles', { headers, body: { id, allow: ['example.com'] } })).status, 201);
  assert.equal(await listed(), undefined);
  for (const route of [path, roster, '/api/computers/does-not-exist']) {
    const r = await admin('GET', route);
    assert.deepEqual([r.status, r.json], [404, { error: 'unknown profile' }]);
  }
  const relays = calls('stream').length;
  assert.equal(await upgrade({}, id), 'dropped');
  assert.equal(calls('stream').length, relays);

  assert.equal((await setRole(null, email)).status, 409);
  assert.equal((await setRole('invalid')).status, 400);
  assert.equal((await setRole('editor', 'missing@example.com')).status, 404);
  const candidates = path + '/candidates';
  assert.ok(!(await admin('GET', candidates, { headers })).json.includes(email));
  assert.ok((await admin('GET', candidates, { headers })).json.includes(owner.email));
  assert.equal((await setRole('viewer')).status, 200);
  assert.ok(!(await admin('GET', candidates, { headers })).json.includes(owner.email));
  assert.equal((await admin('GET', candidates)).status, 403);
  assert.equal((await listed()).role, 'viewer');
  assert.equal((await admin('GET', path)).json.id, id);
  assert.deepEqual((await admin('GET', roster)).json, [{ email: owner.email, role: 'viewer' }, { email, role: 'admin' }]);
  await upgrade({}, id);
  assert.equal(calls('stream').length, relays + 1);
  assert.equal((await admin('POST', path + '/stop', { body: {} })).status, 403);

  const keyBody = { name: 'viewer key', scope: 'profile:' + id, expiresIn: '30d' };
  const scoped = await admin('POST', '/api/keys', { body: keyBody });
  assert.equal(scoped.status, 201);
  assert.equal((await call(scoped.json.key, 'playbook')).error, false);
  assert.equal((await setRole('editor')).status, 200);
  assert.equal((await admin('POST', path + '/start', { body: {} })).json.started, true);
  assert.equal((await admin('POST', path + '/delete', { body: {} })).status, 403);
  assert.equal((await admin('POST', roster, { body: { email: owner.email, role: 'admin' } })).status, 403);
  assert.equal((await setRole(null)).status, 200);
  assert.equal(await listed(), undefined);
  const audit = readFileSync(f.audit, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.agent === id && entry.tool === 'admin:members' && entry.by === email && entry.ok));

  assert.equal(await mcpStatus({ 'x-api-key': scoped.json.key }), 401);
  assert.equal((await admin('POST', '/api/keys', { body: keyBody })).status, 400);

  const global = await admin('POST', '/api/keys', { headers, body: { ...keyBody, scope: 'global' } });
  assert.equal(global.status, 201);
  assert.deepEqual((await admin('GET', '/api/clients', { headers })).json.keys.map((k: any) => k.id), [global.json.id]);
  assert.equal((await admin('POST', `/api/keys/${global.json.id}/revoke`, { body: {} })).status, 404);
  const agent = (name: string, args = {}) => call(global.json.key, name, args);
  assert.deepEqual(JSON.parse((await agent('list_profiles')).text).map((p: any) => p.id), [id]);
  assert.deepEqual(await agent('lease_profile', { profile: 'shop2' }), await agent('lease_profile', { profile: 'missing' }));
  const picked = JSON.parse((await agent('lease_profile', { domain: 'example.com' })).text);
  assert.equal(picked.profile, id);
  const lease = { lease: picked.lease };
  assert.match((await call(tokens.global, 'playbook', lease)).text, /Unknown or expired lease/);
  assert.deepEqual(JSON.parse((await call(tokens.global, 'release_profile', lease)).text), { released: false });
  assert.equal((await setRole('viewer')).status, 200);
  assert.equal((await call(tokens.global, 'playbook', lease)).error, false);
  assert.deepEqual(JSON.parse((await call(tokens.global, 'release_profile', lease)).text), { released: true });

  const created = await agent('create_profile', { id: 'global-acl', allow: ['example.com'] });
  assert.equal(created.error, false);
  assert.deepEqual((await admin('GET', '/api/computers/global-acl/members', { headers })).json, [{ email, role: 'admin' }]);
  assert.equal((await admin('GET', '/api/computers/global-acl')).status, 404);
  assert.equal(JSON.parse(readFileSync(f.audit, 'utf8').trim().split('\n').at(-1)!).by, email);

  sql((db) => db.prepare('DELETE FROM user WHERE email = ?').run(email));
  assert.equal(await mcpStatus({ 'x-api-key': global.json.key }), 401);
});

const createInvite = (email: string, adminRole = false) => admin('POST', '/api/users/invite', { body: { email, admin: adminRole } });
const tokenOf = (invite: { link: string }) => new URL(invite.link).hash.slice('#/invite/'.length);
const accept = (step: string, body: object, cookie = '') => admin('POST', '/api/invite/' + step, { body, headers: { ...adminOrigin(), cookie } });

test('invite enrollment binds the session to the recipient and applies the role only on completion', async () => {
  await restart();
  assert.equal((await fetch(base + '/consent', { redirect: 'manual', headers: { cookie: session } })).status, 200);
  const email = 'invitee@example.com', password = randomBytes(16).toString('hex');
  const issued = await createInvite(email, true);
  assert.equal(issued.status, 201);
  const token = tokenOf(issued.json);
  assert.equal(issued.json.link, `http://localhost:${ADMIN}/#/invite/${token}`);
  assert.equal((await createInvite(email)).status, 409);
  assert.equal((await createInvite(owner.email)).status, 409);
  const open = (await admin('GET', '/api/users/invites')).json;
  assert.deepEqual(open.map((i: any) => [i.id, i.email, i.createdBy, i.admin]), [[issued.json.id, email, owner.email, true]]);
  const start = await accept('start', { token, password });
  assert.equal(start.status, 200);
  assert.deepEqual(Object.keys(start.json), ['totpURI', 'qrSVG']);
  assert.match(start.json.qrSVG, /^<svg /);
  const row = async () => (await admin('GET', '/api/users')).json.find((u: any) => u.email === email);
  assert.deepEqual([(await row()).admin, (await row()).pending], [false, true]);
  assert.equal((await admin('POST', '/api/users/admin', { body: { email, admin: true } })).status, 409);
  assert.equal((await admin('POST', '/api/computers/shop2/members', { body: { email, role: 'viewer' } })).status, 409);
  assert.equal((await admin('POST', '/api/users/remove', { body: { email } })).status, 409);
  assert.equal((await accept('finish', { token, code: totp(start.json.totpURI) }, session)).status, 401);
  // Exercise authorization with a real pending session after the auth provider has enabled its second factor.
  sql(db => db.prepare('UPDATE user SET twoFactorEnabled = 1 WHERE email = ?').run(email));
  const cookie = jar(start.cookies);
  const s = await admin('GET', '/api/auth/get-session', { headers: { cookie } });
  assert.equal(s.json.user.twoFactorEnabled, true);
  assert.equal((await admin('GET', '/api/session', { headers: { cookie } })).status, 401);
  assert.equal((await fetch(base + '/consent', { redirect: 'manual', headers: { cookie } })).status, 302);

  const retry = await accept('start', { token, password });
  assert.equal(retry.status, 200);
  const code = totp(retry.json.totpURI), wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  assert.equal((await accept('finish', { token, code: wrong }, jar(retry.cookies))).status, 401);
  const finished = await accept('finish', { token, code }, jar(retry.cookies));
  assert.equal(finished.status, 200);
  assert.equal(finished.json.backupCodes.length, 10);
  assert.deepEqual([(await row()).admin, (await row()).pending], [true, false]);
  assert.equal((await admin('GET', '/api/session', { headers: { cookie: jar(retry.cookies) } })).status, 401);
  assert.equal((await accept('finish', { token, code }, jar(retry.cookies))).status, 404);
  assert.ok(!readFileSync(f.audit, 'utf8').includes(token));

  const toggle = (adminRole: boolean) => admin('POST', '/api/users/admin', { body: { email, admin: adminRole } });
  assert.equal((await toggle(false)).status, 200);
  sql(db => db.exec('DELETE FROM rateLimit'));
  const half = await admin('POST', '/api/auth/sign-in/email', { headers: adminOrigin(), body: { email, password } });
  assert.equal(half.json.twoFactorRedirect, true);
  const signed = await admin('POST', '/api/auth/two-factor/verify-totp', { headers: { ...adminOrigin(), cookie: jar(half.cookies) }, body: { code: totp(retry.json.totpURI) } });
  assert.equal(signed.status, 200);
  const headers = { cookie: jar(signed.cookies, jar(half.cookies)) };
  assert.deepEqual((await admin('GET', '/api/computers', { headers })).json, []);
  for (const path of ['/api/users', '/api/users/invites']) assert.equal((await admin('GET', path, { headers })).status, 403);
  for (const path of ['/api/users/remove', '/api/users/admin', '/api/users/invite', '/api/users/invites/' + issued.json.id + '/revoke'])
    assert.equal((await admin('POST', path, { headers, body: { email, admin: true } })).status, 403);
});

test('a default invite enrolls a member who can sign in and starts with no profiles', async () => {
  await restart();
  const email = 'new-member@example.com', password = randomBytes(16).toString('hex');
  const issued = await admin('POST', '/api/users/invite', { body: { email } });
  assert.equal(issued.status, 201);
  const token = tokenOf(issued.json);
  const start = await accept('start', { token, password });
  const code = totp(start.json.totpURI);
  assert.equal((await accept('finish', { token, code }, jar(start.cookies))).status, 200);
  sql(db => db.exec('DELETE FROM rateLimit'));
  const half = await admin('POST', '/api/auth/sign-in/email', { headers: adminOrigin(), body: { email, password } });
  assert.equal(half.json.twoFactorRedirect, true);
  const signed = await admin('POST', '/api/auth/two-factor/verify-totp', { headers: { ...adminOrigin(), cookie: jar(half.cookies) }, body: { code: totp(start.json.totpURI) } });
  assert.equal(signed.status, 200);
  const headers = { cookie: jar(signed.cookies, jar(half.cookies)) };
  assert.equal((await admin('GET', '/api/users', { headers })).status, 403);
  assert.deepEqual((await admin('GET', '/api/computers', { headers })).json, []);
});

test('removing a member deletes their private computer and gives the oldest remaining member shared administration', async () => {
  const email = 'departing@example.com', headers = await signInNewUser(email);
  const later = 'later@example.com';
  await signInNewUser(later);
  const roster = '/api/computers/remove-shared/members';
  const remove = (email: string) => admin('POST', '/api/users/remove', { body: { email } });
  assert.equal((await remove('missing@example.com')).status, 404);
  assert.equal((await remove(owner.email)).json.error, 'Cannot remove the last gateway admin');
  assert.equal((await admin('POST', '/api/users/admin', { body: { email: later, admin: true } })).status, 200);
  assert.equal((await remove(owner.email)).json.error, 'Cannot remove yourself');
  for (const id of ['remove-private', 'remove-shared'])
    assert.equal((await admin('POST', '/api/profiles', { headers, body: { id, allow: ['example.com'] } })).status, 201);
  assert.equal((await admin('POST', '/api/computers/remove-private/start', { headers, body: {} })).status, 200);
  for (const other of [owner.email, later])
    assert.equal((await admin('POST', roster, { headers, body: { email: other, role: 'viewer' } })).status, 200);
  const key = await admin('POST', '/api/keys', { headers, body: { name: 'sample', scope: 'global', expiresIn: '30d' } });
  assert.equal(key.status, 201);
  const users = await admin('GET', '/api/users');
  assert.equal(users.json.find((u: any) => u.email === email).privateProfileCount, 1);
  assert.equal((await remove(email)).status, 200);
  assert.ok(calls('remove').some(call => call.id === 'remove-private' && call.keepVolume === false));
  sql(db => {
    assert.equal(db.prepare("SELECT 1 FROM profiles WHERE id = 'remove-private'").get(), undefined);
    assert.equal(db.prepare('SELECT 1 FROM apikey WHERE id = ?').get(key.json.id), undefined);
  });
  assert.equal((await admin('GET', '/api/session', { headers })).status, 401);
  assert.deepEqual((await admin('GET', roster)).json.map((m: any) => [m.email, m.role]).sort(),
    [[owner.email, 'admin'], [later, 'viewer']].sort());
  const audit = readFileSync(f.audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(audit.some(e => e.tool === 'admin:member_promote' && e.by === owner.email && e.member === owner.email && e.agent === 'remove-shared'));
  assert.ok(audit.some(e => e.tool === 'admin:user_remove' && e.by === owner.email && e.agent === email));
});

test('expired enrollment can be replaced, revocation removes its pending user, and only ten invites can be open', async () => {
  await restart();
  const email = 'abandoned@example.com', password = randomBytes(16).toString('hex');
  const issued = await createInvite(email), token = tokenOf(issued.json);
  assert.equal((await accept('start', { token, password })).status, 200);
  sql(db => db.prepare('UPDATE invites SET expires = 0 WHERE id = ?').run(issued.json.id));
  const unavailable = await accept('start', { token, password });
  assert.equal(unavailable.status, 404);
  const replacement = await createInvite(email);
  assert.equal(replacement.status, 201);
  const users = async () => (await admin('GET', '/api/users')).json.map((u: any) => u.email);
  assert.ok(!(await users()).includes(email));
  const next = tokenOf(replacement.json);
  assert.equal((await accept('start', { token: next, password })).status, 200);
  assert.equal((await admin('POST', '/api/users/invites/' + replacement.json.id + '/revoke', { body: {} })).status, 200);
  assert.ok(!(await users()).includes(email));
  for (const t of [next, 'unknown']) {
    const result = await accept('start', { token: t, password });
    assert.deepEqual([result.status, result.json], [404, unavailable.json]);
  }
  for (let i = 0; i < 10; i++) assert.equal((await createInvite(`cap-${i}@example.com`)).status, 201);
  assert.equal((await createInvite(email)).status, 409);
  sql(db => db.exec('DELETE FROM step_up'));
  for (const path of ['/api/users/remove', '/api/users/admin', '/api/users/invite', '/api/users/invites/' + replacement.json.id + '/revoke']) {
    const r = await admin('POST', path, { body: { email, admin: true } });
    assert.deepEqual([r.status, r.json.stepUp], [401, true]);
  }
});

test('invite acceptance enforces the listener boundary and a shared attempt limit', async () => {
  await restart();
  const body = { token: 'unavailable' };
  for (const step of ['start', 'finish']) {
    assert.equal((await admin('POST', '/api/invite/' + step, { body, headers: { origin: 'https://example.com' } })).status, 403);
    assert.equal((await admin('POST', '/api/invite/' + step, { body, headers: { host: 'example.com' } })).status, 403);
  }
  for (let i = 0; i < 10; i++) assert.equal((await accept(i % 2 ? 'start' : 'finish', body)).status, 404);
  assert.equal((await accept('finish', body)).status, 429);
});
