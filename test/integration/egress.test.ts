// Real egress proxy on a temp unix socket. Every refusal here happens before any outbound
// connection, so nothing needs the internet. DNS-dependent cases skip when DNS is unavailable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy, type Proxy } from '../../src/egress/proxy.ts';

const dir = mkdtempSync(join(tmpdir(), 'arb-egress-'));
const sock = join(dir, 'proxy.sock');
let allow = ['example.com', 'localtest.me'];
let proxy: Proxy;
before(async () => { proxy = await startProxy(dir, () => allow); });
after(() => { proxy.close(); rmSync(dir, { recursive: true, force: true }); });

/** Sends one raw request over the socket, resolves with the status line. */
function send(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock, () => s.write(raw));
    let out = '';
    s.on('data', (d) => { out += d; if (out.includes('\r\n')) { resolve(out.split('\r\n')[0]); s.destroy(); } });
    s.on('error', reject);
    s.on('close', () => resolve(out.split('\r\n')[0]));
  });
}
const connect = (target: string) => send(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
const get = (url: string) => send(`GET ${url} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);

test('socket is world-writable (the computer runs as another uid)', () => {
  assert.equal(statSync(sock).mode & 0o777, 0o666);
});

test('CONNECT refused: private IPs, metadata, foreign domains, other ports, loopback names', async () => {
  for (const t of ['10.0.0.1:443', '169.254.169.254:443', '127.0.0.1:443', 'example.org:443', 'example.com:8443',
    'example.com:80', 'localhost:443', 'evil.example.com.attacker.io:443', 'user@example.com:443'])
    assert.match(await connect(t), /^HTTP\/1\.1 403/, t);
});

test('plain HTTP refused: private targets, foreign domains, non-http schemes, relative paths', async () => {
  for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://example.org/', 'https://example.com/',
    'http://example.com:8080/', '/relative'])
    assert.match(await get(u), /^HTTP\/1\.1 403/, u);
});

test('allowlisted name resolving to loopback is refused (DNS rebinding)', async (t) => {
  // localtest.me is a public wildcard record pointing at 127.0.0.1.
  const address = await lookup('localtest.me', { family: 4 }).then((r) => r.address, () => null);
  if (address !== '127.0.0.1') return t.skip('needs DNS resolution of localtest.me to 127.0.0.1');
  assert.match(await connect('localtest.me:443'), /^HTTP\/1\.1 403/);
  assert.match(await get('http://localtest.me/'), /^HTTP\/1\.1 403/);
});

test('allowlist is read on every request', async () => {
  allow = [];
  try { assert.match(await connect('example.com:443'), /^HTTP\/1\.1 403/); } finally { allow = ['example.com', 'localtest.me']; }
});

test('restrict() pins the origin and drops open connections', async () => {
  const s = net.connect(sock);
  await new Promise((r) => s.once('connect', r));
  const closed = new Promise((r) => s.once('close', r));
  proxy.restrict('https://www.example.com');
  await closed;
  // Allowed domain, other origin: refused before DNS.
  assert.match(await connect('example.com:443'), /^HTTP\/1\.1 403/);
  proxy.restrict(undefined);
});
