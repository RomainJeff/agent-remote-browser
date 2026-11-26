// End-to-end smoke against a running compose stack (CI e2e job, or by hand), like an agent and an operator would use it.
// Every credential is generated here and lives in memory only. Run from the repository root, the stack up:
//   COMPOSE_PROJECT_NAME=arb-dev npm run smoke            (EXPECT_RUNTIME=runsc in CI: the browser ran under gVisor)
// Steps: admin create (CLI) -> admin login with TOTP -> profile + scoped API key -> MCP open/snapshot/refusal ->
// computer hardening (read-only rootfs, tmpfs, runtime) -> /metrics -> hostile runner requests -> backup-db.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { totp } from '../totp.ts';

const MCP = Number(process.env.MCP_PORT || 18787), ADMIN = Number(process.env.ADMIN_PORT || 18788);
const P = process.env.ARB_PREFIX || 'arb', base = `http://localhost:${MCP}`;
const email = 'admin@example.test', password = randomBytes(18).toString('base64url');
const log = (...a: unknown[]) => console.log('[smoke]', ...a);
const compose = (...a: string[]) => execFileSync('docker', ['compose', ...a], { encoding: 'utf8' });
const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// 1. Admin account through the CLI: password on stdin, then the code computed from the printed setup key.
const uri = await new Promise<string>((resolve, reject) => {
  const p = spawn('docker', ['compose', 'exec', '-T', 'gateway', 'node', 'src/cli.ts', 'admin', 'create', email]);
  let out = '', u = '';
  p.stdout.on('data', (d) => {
    out += d;
    const m = out.match(/^Setup key: ([A-Z2-7 ]+)$/m);
    if (m && !u) { u = m[1]; p.stdin.write(totp(u) + '\n'); }
  });
  p.stderr.on('data', (d) => { out += d; });
  p.stdin.write(password + '\n');
  p.on('close', (c) => {
    assert.ok(!out.includes(password), 'password printed by the CLI');
    c === 0 && u ? resolve(u) : reject(Error(`admin create failed: ${out.replace(u, '<KEY>')}`));
  });
});
log('admin created');

function jar(set: string[], cookie = '') {
  const m = new Map(cookie.split('; ').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv]));
  for (const c of set) { const kv = c.split(';')[0], n = kv.slice(0, kv.indexOf('=')); if (kv.length > n.length + 1) m.set(n, kv); else m.delete(n); }
  return [...m.values()].join('; ');
}
let session = '';
function req(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any; text: string; cookies: string[] }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`,
      ...(session && { cookie: session }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; }).on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode!, json, text, cookies: [res.headers['set-cookie'] ?? []].flat() });
      });
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const admin = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => req(ADMIN, method, path, body, headers);

// 2. Admin login: password alone gives no rights, TOTP gives a session.
assert.equal((await admin('GET', '/api/computers')).status, 401);
assert.equal((await admin('POST', '/api/auth/sign-in/email', { email, password: 'wrong-' + password })).status, 401);
const half = await admin('POST', '/api/auth/sign-in/email', { email, password });
assert.equal(half.json?.twoFactorRedirect, true);
const ok = await admin('POST', '/api/auth/two-factor/verify-totp', { code: totp(uri) }, { cookie: jar(half.cookies) });
assert.equal(ok.status, 200);
session = jar(ok.cookies, jar(half.cookies));
log('admin login with TOTP ok');

// 3. A profile and an API key scoped to it.
assert.equal((await admin('POST', '/api/profiles', { id: 'smoke', allow: ['example.com'] })).status, 201);
const key = await admin('POST', '/api/keys', { name: 'smoke key', scope: 'profile:smoke', expiresIn: '30d' });
assert.equal(key.status, 201);
assert.match(key.json.key, /^arb_k_/);

// 4. MCP through the gateway: the browser starts in its container, reads a page, and stays inside its allowlist.
async function call(name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { 'x-api-key': key.json.key } } }));
  try { const r = await client.callTool({ name, arguments: args }) as any; return { error: !!r.isError, text: r.content[0].text as string }; }
  finally { await client.close(); }
}
const open = await call('open', { url: 'https://example.com/' });
assert.ok(!open.error, open.text);
const snap = await call('snapshot');
assert.ok(!snap.error, snap.text);
assert.match(snap.text, /untrusted_page_content origin="https:\/\/example\.com/);
assert.ok((await call('open', { url: 'https://example.org/' })).error, 'outside the allowlist');
log('MCP open + snapshot ok, example.org refused');

// 4b. Lot 7b admin UX: step-up window open after the TOTP sign-in, key expiry and last IP listed, saved-login
// test through the real agent-browser (example.com has no form: ok or not, the shape and the secrecy are what count).
const me = await admin('GET', '/api/session');
assert.ok(me.json.stepUpRemainingS > 0 && me.json.stepUpRemainingS <= 900, me.text);
const keys = (await admin('GET', '/api/clients')).json.keys;
assert.equal(keys.length, 1);
assert.ok(keys[0].expiresAt && keys[0].noExpiry === false && keys[0].lastIp, JSON.stringify(keys[0]));
const sitePw = randomBytes(18).toString('base64url');
assert.equal((await admin('POST', '/api/computers/smoke/login-save', { site: 'main', url: 'https://example.com/', username: 'smoke', password: sitePw })).status, 200);
const t = await admin('POST', '/api/computers/smoke/login-test', { site: 'main' });
assert.equal(t.status, 200, t.text);
assert.equal(typeof t.json.ok, 'boolean');
assert.match(t.json.url, /^https:\/\/example\.com/);
const tested = (await admin('GET', '/api/computers/smoke')).json.logins[0];
assert.equal(tested.lastResult, t.json.ok ? 'ok' : 'fail');
assert.ok(!JSON.stringify(tested).includes(sitePw));
assert.ok(!compose('logs', '--no-color').includes(sitePw), 'password in the logs');
assert.ok(!compose('exec', '-T', 'gateway', 'cat', '/data/audit.jsonl').includes(sitePw), 'password in the audit');
assert.equal((await admin('POST', '/api/computers/smoke/login-delete', { site: 'main' })).status, 200);
log(`step-up ${me.json.stepUpRemainingS}s, key expiry + last IP listed, login test: ok=${t.json.ok} on ${t.json.url}`);

// 5. The computer as created by the runner: read-only rootfs, writable tmpfs, the expected runtime.
const name = `${P}-smoke`;
const hc = JSON.parse(docker('inspect', '--format', '{{json .HostConfig}}', name));
assert.equal(hc.ReadonlyRootfs, true);
assert.equal(hc.NetworkMode, 'none');
if (process.env.EXPECT_RUNTIME) assert.equal(hc.Runtime, process.env.EXPECT_RUNTIME);
assert.throws(() => docker('exec', name, 'touch', '/usr/smoke'), 'rootfs is read-only');
docker('exec', name, 'sh', '-c', 'touch /tmp/smoke /home/agent/smoke && rm /tmp/smoke /home/agent/smoke');
log(`computer: runtime ${hc.Runtime || 'default'}, read-only rootfs, tmpfs writable`);

// 6. /metrics: admin listener only, and it saw the calls above.
const m = await admin('GET', '/metrics', undefined, { cookie: '' });
assert.equal(m.status, 200);
const value = (series: string) => Number(m.text.match(new RegExp(`^${series.replace(/[{}"]/g, '\\$&')} (\\d+)$`, 'm'))?.[1] ?? NaN);
assert.ok(value('arb_tool_calls_total{tool="open",outcome="ok"}') >= 1, m.text);
assert.ok(value('arb_tool_calls_total{tool="open",outcome="error"}') >= 1, m.text);
assert.ok(value('arb_auth_failures_total{kind="password"}') >= 1, m.text);
assert.equal(value('arb_runner_up'), 1);
assert.ok(value('arb_computers_running') >= 1);
assert.ok(!m.text.includes(key.json.key) && !m.text.includes('smoke'), 'no secret or id in metrics');
assert.equal((await req(MCP, 'GET', '/metrics')).status, 404, 'not on the public listener');
log('metrics ok:', m.text.split('\n').filter((l) => /^arb_(runner_up|computers_running|leases_active|tool_calls_total)/.test(l)).join(' | '));

// 7. Hostile requests on the runner socket, from the gateway container (the only other holder of the socket).
const hostile = [{ op: 'exec', id: 'smoke', argv: ['sh', '-c', 'id'], timeoutMs: 5000 }, { op: 'ensure', id: '../x' },
  { op: 'create', Image: 'alpine', HostConfig: { Privileged: true } }];
const replies = compose('exec', '-T', 'gateway', 'node', '-e', `
  const net = require('node:net');
  (async () => { for (const r of ${JSON.stringify(hostile)}) await new Promise((done) => {
    const s = net.connect('/run/arb-runner/runner.sock'); let out = '';
    s.on('data', (d) => out += d).on('close', () => { console.log(out.trim()); done(); }).end(JSON.stringify(r) + '\\n');
  }); })();`).trim().split('\n');
assert.deepEqual(replies.map((l) => JSON.parse(l)), hostile.map(() => ({ ok: false, error: 'invalid request' })));
const refused = compose('logs', '--no-color', 'runner').split('\n').filter((l) => l.includes('"runner refused a request"'));
assert.ok(refused.length >= hostile.length, `runner logged ${refused.length} refusals`);
assert.ok(refused.every((l) => !l.includes('Privileged') && !l.includes('sh -c')), 'refusal logs do not echo the request');
log(`runner refused ${hostile.length} hostile requests and logged them`);

// 8. backup-db while the gateway runs.
const b = compose('exec', '-T', 'gateway', 'sh', '-c', 'node src/cli.ts backup-db /tmp/smoke.db; s=$?; rm -f /tmp/smoke.db; exit $s');
assert.match(b, /backed up to \/tmp\/smoke\.db: 1 profile\(s\), 0 login\(s\), integrity ok\./);
log('backup-db ok');
log('ALL OK');
