// The real gateway in a child process, on free ports, with temp state and a fake `docker` first on PATH
// (test/fixtures/bin/docker records argv, returns canned agent-browser output). Tests share one gateway
// and run in order: later tests rely on the profile and tokens created by earlier ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = new URL('../..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'arb-gw-'));
const f = {
  state: join(dir, 'state.json'), audit: join(dir, 'audit.jsonl'), kill: join(dir, 'KILL'),
  key: join(dir, 'login.key'), egress: join(dir, 'egress'), docker: join(dir, 'docker.log'),
};
let gateway: ChildProcess, PORT = 0, ADMIN = 0, base = '';
const tokens = { global: '', shop: '' };
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

before(async () => {
  [PORT, ADMIN] = [await freePort(), await freePort()];
  base = `http://127.0.0.1:${PORT}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: join(root, 'test/fixtures/bin') + ':' + process.env.PATH, ARB_PREFIX: 'arb',
    PORT: String(PORT), ADMIN_PORT: String(ADMIN), STATE_FILE: f.state, AUDIT_FILE: f.audit, KILL_FILE: f.kill,
    LOGIN_KEY_FILE: f.key, EGRESS_DIR: f.egress, FAKE_DOCKER_LOG: f.docker,
  };
  delete env.PUBLIC_URL; delete env.IMAGE; delete env.SANDBOX_RUNTIME;
  gateway = spawn(process.execPath, ['gateway.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('gateway did not start:\n' + out)), 10_000);
    for (const s of [gateway.stdout!, gateway.stderr!]) s.on('data', (d) => {
      out += d;
      if (out.includes('admin UI on')) { clearTimeout(timer); resolve(); }
    });
    gateway.on('exit', (code) => reject(Error(`gateway exited ${code}:\n${out}`)));
  });
});
after(() => { gateway?.kill(); rmSync(dir, { recursive: true, force: true }); });

/** Raw admin request: full control over Host, Origin and fetch metadata headers. */
function admin(method: string, path: string, { body, headers = {} }: { body?: unknown, headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number, json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ADMIN, method, path,
      headers: { host: `127.0.0.1:${ADMIN}`, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => { let json; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode!, json }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
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
const dockerCalls = (): string[][] => existsSync(f.docker) ? readFileSync(f.docker, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const runs = () => dockerCalls().filter((c) => c[0] === 'run');
const agentBrowser = (op: string) => dockerCalls().filter((c) => c[0] === 'exec' && c.includes('agent-browser') && c.includes(op));

test('startup only looks for its own prefixed containers', () => {
  assert.deepEqual(dockerCalls()[0], ['ps', '--filter', 'label=arb-computer', '--format', '{{.Names}}']);
});

test('admin issues tokens, MCP without a valid bearer gets the OAuth hint', async () => {
  const g = await admin('POST', '/api/global-token', { body: {} });
  assert.equal(g.status, 200);
  tokens.global = g.json.token;
  assert.match(tokens.global, /^acg_/);
  const p = await admin('POST', '/api/profiles', { body: { id: 'shop', allow: ['Example.com'] } });
  assert.equal(p.status, 201);
  tokens.shop = p.json.token;
  assert.match(tokens.shop, /^acp_/);
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'shop', allow: ['example.com'] } })).status, 409);
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'Bad', allow: ['example.com'] } })).status, 400);
  assert.equal((await admin('POST', '/api/profiles', { body: { id: 'lan', allow: ['nas.lan'] } })).status, 400);

  const state = readFileSync(f.state, 'utf8');
  assert.ok(!state.includes(tokens.global) && !state.includes(tokens.shop), 'tokens stored as hashes only');
  assert.equal(statSync(f.state).mode & 0o777, 0o600);

  for (const authorization of [undefined, 'Bearer acp_wrong']) {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization && { authorization }) }, body: '{}' });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  }
});

test('profile token: browser tools only, open outside the allowlist never reaches docker', async () => {
  const names = await toolNames(tokens.shop);
  assert.deepEqual(names, ['back', 'click', 'fill', 'get_text', 'login', 'open', 'press', 'screenshot', 'snapshot']);
  for (const url of ['https://example.org/', 'http://169.254.169.254/', 'https://example.com:8443/', 'file:///etc/passwd']) {
    const r = await call(tokens.shop, 'open', { url });
    assert.ok(r.error, url);
    assert.match(r.text, /^Domain not allowed/, url);
  }
  assert.equal(runs().length, 0);
});

test('open on the allowlist starts one hardened, prefixed computer', async () => {
  const r = await call(tokens.shop, 'open', { url: 'https://www.example.com/' });
  assert.ok(!r.error, r.text);
  assert.deepEqual(JSON.parse(r.text), { title: 'Fake page', url: 'https://www.example.com/' });
  await call(tokens.shop, 'open', { url: 'https://example.com/' });
  const [run] = runs();
  assert.equal(runs().length, 1, 'second call reuses the running computer');
  const flag = (k: string) => run[run.indexOf(k) + 1];
  assert.equal(flag('--name'), 'arb-shop');
  assert.equal(flag('--label'), 'arb-computer=shop');
  assert.equal(flag('--network'), 'none');
  assert.equal(flag('--security-opt'), 'no-new-privileges');
  assert.ok(run.includes('--cap-drop=ALL'));
  assert.equal(flag('-v'), 'arb-profile-shop:/home/agent/.agent-browser');
  assert.match(flag('--mount'), /^type=volume,src=arb-egress,dst=\/egress,volume-subpath=shop,readonly$/);
  assert.ok(run.includes('arb-computer:dev'));
  assert.ok(!run.some((a) => /^(ac-|agent-computer)/.test(a)), 'no name from the POC namespace');
  assert.equal(statSync(join(f.egress, 'shop', 'proxy.sock')).mode & 0o777, 0o666);

  const snap = await call(tokens.shop, 'snapshot');
  assert.match(snap.text, /^<untrusted_page_content origin="https:\/\/example.com">/);
});

test('saved login: password only crosses docker through stdin', async () => {
  const password = randomBytes(18).toString('base64url');
  assert.equal((await admin('POST', '/api/computers/shop/login-save',
    { body: { site: 'main', url: 'https://example.org/login', username: 'fixture', password } })).status, 400, 'URL off the allowlist');
  assert.equal((await admin('POST', '/api/computers/shop/login-save',
    { body: { site: 'main', url: 'https://example.com/login', username: 'fixture', password } })).status, 200);

  const r = await call(tokens.shop, 'login', { site: 'main' });
  assert.ok(!r.error, r.text);
  assert.equal(JSON.parse(r.text).submitted, true);
  assert.equal((await call(tokens.shop, 'login', { site: 'other' })).error, true);

  const save = agentBrowser('--password-stdin')[0];
  assert.ok(save.includes('-i'));
  assert.ok(dockerCalls().some((c) => c[0] === '#stdin-sha256' && c[1] === sha256(password)), 'password went through stdin');
  assert.equal(agentBrowser('delete').length, 1, 'in-container vault entry deleted');
  const details = await admin('GET', '/api/computers/shop');
  assert.deepEqual(details.json.logins, [{ site: 'main', url: 'https://example.com/login', username: 'fixture' }]);
  for (const file of [f.docker, f.state, f.audit]) assert.ok(!readFileSync(file, 'utf8').includes(password), file);
  assert.ok(!JSON.stringify(details.json).includes(password));
});

test('kill switch refuses every tool until removed', async () => {
  writeFileSync(f.kill, '');
  try {
    const before = dockerCalls().length;
    const r = await call(tokens.shop, 'open', { url: 'https://example.com/' });
    assert.deepEqual(r, { error: true, text: 'agent-computer is disabled (kill switch)' });
    assert.equal(dockerCalls().length, before);
    const { agent, tool, ok } = JSON.parse(readFileSync(f.audit, 'utf8').trim().split('\n').at(-1)!);
    assert.deepEqual({ agent, tool, ok }, { agent: 'shop', tool: 'open', ok: false });
  } finally { rmSync(f.kill); }
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
});

test('a lease locks the profile token; the global token drives the profile through the lease', async () => {
  assert.deepEqual(await toolNames(tokens.global),
    ['back', 'click', 'create_profile', 'fill', 'get_text', 'lease_profile', 'list_profiles', 'login', 'open', 'press', 'release_profile', 'screenshot', 'snapshot']);
  assert.match((await call(tokens.global, 'open', { lease: 'acl_bogus', url: 'https://example.com/' })).text, /Unknown or expired lease/);
  assert.match((await call(tokens.global, 'lease_profile', { domain: 'example.org' })).text, /No free profile/);

  const leased = await call(tokens.global, 'lease_profile', { domain: 'www.example.com', minutes: 5 });
  assert.ok(!leased.error, leased.text);
  const { lease, profile } = JSON.parse(leased.text);
  assert.equal(profile, 'shop');
  assert.match((await call(tokens.shop, 'open', { url: 'https://example.com/' })).text, /^This browser is leased until /);
  assert.match((await call(tokens.global, 'lease_profile', { profile: 'shop' })).text, /already leased/);
  const viaLease = await call(tokens.global, 'open', { lease, url: 'https://example.com/a' });
  assert.ok(!viaLease.error, viaLease.text);
  assert.deepEqual(JSON.parse((await call(tokens.global, 'release_profile', { lease })).text), { released: true });
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
  const last = JSON.parse(readFileSync(f.audit, 'utf8').trim().split('\n').findLast((l) => l.includes('"via"'))!);
  assert.equal(last.via, 'global');
});

test('admin refuses cross-origin, cross-site, foreign Host and non-JSON writes', async () => {
  const state = readFileSync(f.state, 'utf8');
  for (const headers of [{ origin: 'http://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' }, { host: `evil.test:${ADMIN}` }, { host: `127.0.0.1:${PORT}` }] as Record<string, string>[]) {
    assert.equal((await admin('GET', '/api/computers', { headers })).status, 403, JSON.stringify(headers));
    assert.equal((await admin('POST', '/api/global-token', { body: {}, headers })).status, 403, JSON.stringify(headers));
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])
    assert.equal((await admin('POST', '/api/global-token', { body: '{}', headers: { 'content-type': type } })).status, 415, type);
  assert.equal((await admin('POST', '/api/global-token', { body: '{}', headers: { 'content-type': '' } })).status, 415);
  assert.equal(readFileSync(f.state, 'utf8'), state, 'no refused write changed state');
  assert.equal((await admin('GET', '/api/computers', { headers: { origin: `http://127.0.0.1:${ADMIN}`, 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('live view WebSocket: cross-origin upgrade dropped before touching the computer', async () => {
  const upgrade = (headers: Record<string, string>) => new Promise<string>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: ADMIN, path: '/api/computers/shop/stream', headers: {
      host: `127.0.0.1:${ADMIN}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
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
  assert.equal(streams(), n, 'no docker exec for refused upgrades');
  // Same-origin reaches the computer (the fake relay exits at once, so the socket closes without a 101).
  await upgrade({ origin: `http://127.0.0.1:${ADMIN}` });
  assert.equal(streams(), n + 1);
});

test('OAuth: DCR, consent, PKCE, refresh rotation, revocation on token regeneration', async () => {
  const post = (path: string, body: object) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const meta = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
  assert.deepEqual(meta.authorization_servers, [base]);
  const as = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);

  const redirect_uri = 'http://127.0.0.1:9/callback';
  const reg = await post('/register', { redirect_uris: [redirect_uri], token_endpoint_auth_method: 'none', client_name: 'test' });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const code_verifier = randomBytes(32).toString('base64url');
  const code_challenge = createHash('sha256').update(code_verifier).digest('base64url');
  const authorize = async (token: string) => {
    const page = await fetch(base + '/authorize?' + new URLSearchParams({ client_id, redirect_uri, response_type: 'code', code_challenge_method: 'S256', code_challenge, state: 'xyz' }));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const pending = (await page.text()).match(/name="pending" value="([^"]+)"/)![1];
    const r = await post('/authorize', { pending, token });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location')!);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    assert.equal(loc.searchParams.get('iss'), base);
    return loc.searchParams.get('code')!;
  };
  const exchange = (code: string, verifier = code_verifier) => post('/token', { grant_type: 'authorization_code', client_id, redirect_uri, code, code_verifier: verifier });

  // PKCE failure burns the code.
  const burnt = await authorize(tokens.shop);
  assert.equal((await exchange(burnt, randomBytes(32).toString('base64url'))).status, 400);
  assert.equal((await exchange(burnt)).status, 400);

  const code = await authorize(tokens.shop);
  const ok = await exchange(code);
  assert.equal(ok.status, 200);
  const issued = await ok.json();
  assert.match(issued.access_token, /^aca_/);
  assert.equal((await exchange(code)).status, 400, 'code replay');
  assert.ok((await toolNames(issued.access_token)).includes('open'));

  const refresh = (refresh_token: string) => post('/token', { grant_type: 'refresh_token', client_id, refresh_token });
  const rotated = await refresh(issued.refresh_token);
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.equal((await refresh(issued.refresh_token)).status, 400, 'old refresh token is single use');

  const pendingCode = await authorize(tokens.shop);
  const regen = await admin('POST', '/api/computers/shop/token', { body: {} });
  assert.equal(regen.status, 200);
  tokens.shop = regen.json.token;
  assert.equal((await exchange(pendingCode)).status, 400, 'code minted with the old credential');
  assert.equal((await refresh(next.refresh_token)).status, 400, 'refresh token revoked');
  const old = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${next.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(old.status, 401, 'access token revoked');
  assert.equal((await call(tokens.shop, 'open', { url: 'https://example.com/' })).error, false);
});

test('deleting a profile removes only its own prefixed container and volume', async () => {
  assert.equal((await admin('POST', '/api/computers/shop/delete', { body: {} })).status, 200);
  const rm = dockerCalls().filter((c) => c[0] === 'rm' || (c[0] === 'volume' && c[1] === 'rm'));
  assert.deepEqual(rm.slice(-2), [['rm', '-f', 'arb-shop'], ['volume', 'rm', '-f', 'arb-profile-shop']]);
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.shop}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401, 'token of a deleted profile');
  assert.equal((await admin('GET', '/api/computers/shop')).status, 404);
});
