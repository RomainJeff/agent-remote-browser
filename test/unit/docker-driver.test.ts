// DockerDriver against a fake Engine API on a temp Unix socket: the requests it builds, and exec stream demuxing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerDriver } from '../../src/host/docker.ts';
import { parseProfileId } from '../../src/policy.ts';

const dir = mkdtempSync(join(tmpdir(), 'arb-eng-'));
const socket = join(dir, 'docker.sock');
const id = parseProfileId('shop')!;
let log: { method: string; url: string; body?: any }[] = [];
let running = false;

const frame = (stream: number, s: string) => {
  const p = Buffer.from(s), h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(p.length, 4);
  return Buffer.concat([h, p]);
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; }).on('end', () => {
    const url = req.url!, method = req.method!;
    log.push({ method, url, ...(raw && { body: JSON.parse(raw) }) });
    const reply = (status: number, body?: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(body && JSON.stringify(body));
    if (method === 'GET' && url === '/v1.47/containers/arb-shop/json')
      return running ? reply(200, { State: { Running: true, StartedAt: '2026-01-01T00:00:00Z' }, HostConfig: { NetworkMode: 'none' } }) : reply(404, { message: 'No such container: arb-shop' });
    if (url === '/v1.47/containers/arb-shop/start') { running = true; return reply(204); }
    if (url === '/v1.47/containers/arb-shop/exec') return reply(201, { Id: 'e1' });
    if (url === '/v1.47/exec/e1/json') return reply(200, { Running: false, ExitCode: 3 });
    if (url.startsWith('/v1.47/containers/json')) return reply(200, [
      { Labels: { 'arb-computer': 'shop' }, State: 'running', Created: 1 }, { Labels: { 'arb-computer': 'old' }, State: 'exited', Created: 2 }]);
    if (method === 'DELETE') return reply(204);
    reply(201, {});
  });
});

// exec start: hijack, echo stdin back on stdout (split across frames and chunks), one stderr frame, then close.
server.on('upgrade', (req, sock, head) => {
  log.push({ method: req.method!, url: req.url! });
  const skip = Number(req.headers['content-length'] ?? 0);
  let buf = Buffer.from(head);
  sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
  sock.on('end', () => {
    const stdin = buf.subarray(skip).toString();
    const out = Buffer.concat([frame(1, 'got:'), frame(2, 'warn'), frame(1, stdin)]);
    sock.write(out.subarray(0, 5));
    sock.end(out.subarray(5));
  });
});

before(() => new Promise<void>((r) => server.listen(socket, r)));
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const driver = new DockerDriver({ socket, prefix: 'arb', image: 'arb-computer:dev', runtime: 'runsc' });

test('ensure on a missing computer: volume, fixed hardened spec, start', async () => {
  log = [];
  const c = await driver.ensure(id, { egressDir: '/unused' });
  assert.deepEqual(c, { id: 'shop', running: true, startedAt: Date.parse('2026-01-01T00:00:00Z') });
  assert.deepEqual(log.map((l) => `${l.method} ${l.url}`), [
    'GET /v1.47/containers/arb-shop/json',
    'POST /v1.47/volumes/create',
    'POST /v1.47/containers/create?name=arb-shop',
    'POST /v1.47/containers/arb-shop/start',
    'GET /v1.47/containers/arb-shop/json',
  ]);
  assert.deepEqual(log[1].body, { Name: 'arb-profile-shop', Labels: { 'arb-computer': 'shop' } });
  const spec = log[2].body;
  assert.equal(spec.Image, 'arb-computer:dev');
  assert.deepEqual(spec.Labels, { 'arb-computer': 'shop' });
  const h = spec.HostConfig;
  assert.equal(h.NetworkMode, 'none');
  assert.deepEqual(h.CapDrop, ['ALL']);
  assert.deepEqual(h.SecurityOpt, ['no-new-privileges']);
  assert.equal(h.Runtime, 'runsc');
  assert.deepEqual(h.Mounts, [
    { Type: 'volume', Source: 'arb-profile-shop', Target: '/home/agent/.agent-browser' },
    { Type: 'volume', Source: 'arb-egress', Target: '/egress', ReadOnly: true, VolumeOptions: { Subpath: 'shop' } },
  ]);

  log = [];
  await driver.ensure(id, { egressDir: '/unused' });
  assert.deepEqual(log.map((l) => l.method), ['GET'], 'running computer: inspect only');
});

test('exec: stdin sent then closed, stdout and stderr demuxed, exit code read', async () => {
  log = [];
  const r = await driver.exec(id, ['cat'], { stdin: 'secret', timeoutMs: 5000 });
  assert.deepEqual(r, { code: 3, stdout: 'got:secret', stderr: 'warn' });
  assert.deepEqual(log[0].body, { Cmd: ['cat'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false });
  assert.equal(log[1].url, '/v1.47/exec/e1/start');
});

test('list maps the prefix label; remove deletes container and volume', async () => {
  log = [];
  assert.deepEqual(await driver.list(), [{ id: 'shop', running: true, startedAt: 1000 }, { id: 'old', running: false, startedAt: 2000 }]);
  assert.deepEqual(JSON.parse(new URL('http://x' + log[0].url).searchParams.get('filters')!), { label: ['arb-computer'] });
  log = [];
  await driver.remove(id, { keepVolume: false });
  assert.deepEqual(log.map((l) => `${l.method} ${l.url}`),
    ['DELETE /v1.47/containers/arb-shop?force=true', 'DELETE /v1.47/volumes/arb-profile-shop?force=true']);
});
