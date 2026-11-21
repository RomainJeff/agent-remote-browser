// Validates both compose files with the local `docker compose` and checks the exposure rules they must keep.
//   npm run check:compose     (needs Docker Compose >= 2.24: `include`, `!reset`)
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
type Service = { image?: string; build?: unknown; ports?: { host_ip?: string; published?: string; target: number }[];
  environment?: Record<string, string | null>; command?: string[] };
const config = (file: string, env: Record<string, string> = {}) => JSON.parse(execFileSync('docker',
  ['compose', '-f', file, 'config', '--format', 'json'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })) as
  { services: Record<string, Service>; secrets: Record<string, unknown> };
const pinned = (s: Record<string, Service>) => { for (const [n, v] of Object.entries(s)) if (v.image && !v.build) assert.match(v.image, /@sha256:[0-9a-f]{64}$/, n); };

// Without tunnel: MCP on BIND_ADDR, admin on loopback whatever BIND_ADDR, client IP headers never trusted.
for (const bind of ['', '0.0.0.0']) {
  const { services: s } = config('compose.yaml', { BIND_ADDR: bind });
  assert.deepEqual(s.gateway.ports!.map((p) => `${p.host_ip}:${p.published}:${p.target}`), [`${bind || '127.0.0.1'}:18787:18787`, '127.0.0.1:18788:18788']);
  assert.ok(!s.gateway.environment!.TRUST_PROXY, 'TRUST_PROXY with a published port');
  assert.ok(!('cloudflared' in s));
}

// Tunnel: no published port at all, Cloudflare's client IP trusted, named tunnel with its token as a Docker secret.
const t = config('compose.tunnel.yaml', { BIND_ADDR: '0.0.0.0' });
for (const [n, v] of Object.entries(t.services)) assert.ok(!v.ports?.length, `${n} publishes ${JSON.stringify(v.ports)}`);
assert.equal(t.services.gateway.environment!.TRUST_PROXY, 'cloudflare');
const cf = t.services.cloudflared;
assert.deepEqual(cf.command, ['tunnel', '--no-autoupdate', 'run'], 'named tunnel only, never a quick tunnel (--url)');
assert.equal(cf.environment!.TUNNEL_TOKEN_FILE, '/run/secrets/cloudflared_token');
assert.ok(!cf.environment!.TUNNEL_TOKEN && 'cloudflared_token' in t.secrets);
pinned(t.services);
console.log('compose.yaml and compose.tunnel.yaml: ok');
