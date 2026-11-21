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
// name -> container: created ones keep the labels of their spec; arb-gateway-1 stands for compose's own gateway.
const containers = new Map<string, { Labels: Record<string, string> | null; running: boolean }>(
  [['arb-gateway-1', { Labels: { 'com.docker.compose.service': 'gateway' }, running: true }]]);
const volumes = new Map<string, Record<string, string> | null>([['ac-profile-shop', null], ['arb-profile-gateway-1', null]]);
let copyExit = 0, imageId = 'sha256:aaa';

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
    const [, name, action] = url.match(/^\/v1\.47\/containers\/([\w-]+)(?:\/(\w+)|\?force=true)?$/) ?? [];
    const c = name && containers.get(name);
    if (method === 'GET' && action === 'json') return c
      ? reply(200, { Config: { Labels: c.Labels }, State: { Running: c.running, StartedAt: '2026-01-01T00:00:00Z' } })
      : reply(404, { message: 'No such container' });
    if (action === 'start' && c) { c.running = true; return reply(204); }
    if (method === 'DELETE' && name) { containers.delete(name); return reply(204); }
    const created = url.match(/^\/v1\.47\/containers\/create\?name=([\w-]+)$/)?.[1];
    if (created) containers.set(created, { Labels: JSON.parse(raw).Labels ?? null, running: false });
    if (url === '/v1.47/images/arb-computer:dev/json') return reply(200, { Id: imageId });
    if (url === '/v1.47/containers/arb-shop/exec') return reply(201, { Id: 'e1' });
    if (url === '/v1.47/exec/e1/json') return reply(200, { Running: false, ExitCode: 3 });
    if (url.startsWith('/v1.47/containers/json')) return reply(200, [
      { Labels: { 'arb-computer': 'shop' }, State: 'running', Created: 1 }, { Labels: { 'arb-computer': 'old' }, State: 'exited', Created: 2 }]);
    const vol = url.match(/^\/v1\.47\/volumes\/([\w-]+)(?:\?force=true)?$/)?.[1];
    if (vol && method === 'GET') return volumes.has(vol) ? reply(200, { Name: vol, Labels: volumes.get(vol) }) : reply(404, { message: 'no such volume' });
    if (vol && method === 'DELETE') { volumes.delete(vol); return reply(204); }
    if (url === '/v1.47/volumes/create') volumes.set(JSON.parse(raw).Name, JSON.parse(raw).Labels ?? null);
    if (url === '/v1.47/containers/arb-migrate-shop/wait') return reply(200, { StatusCode: copyExit });
    if (method === 'DELETE') return reply(204);
    reply(201, {});
  });
});

// exec start: hijack, echo stdin back on stdout (split across frames and chunks), one stderr frame, then close.
server.on('upgrade', (req, sock, head) => {
  log.push({ method: req.method!, url: req.url! });
  // The start body precedes stdin on the wire. Node <= 24 leaves it in the socket, newer Node may parse it into req.
  const body = JSON.stringify({ Detach: false, Tty: false });
  let buf = Buffer.from(head);
  sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
  sock.on('end', () => {
    const raw = buf.toString(), stdin = raw.startsWith(body) ? raw.slice(body.length) : raw;
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
    'GET /v1.47/images/arb-computer:dev/json',
    'GET /v1.47/containers/arb-shop/json',
    'POST /v1.47/volumes/create',
    'POST /v1.47/containers/create?name=arb-shop',
    'POST /v1.47/containers/arb-shop/start',
    'GET /v1.47/containers/arb-shop/json',
  ]);
  assert.deepEqual(log[2].body, { Name: 'arb-profile-shop', Labels: { 'arb-computer': 'shop' } });
  const spec = log[3].body;
  assert.equal(spec.Image, 'arb-computer:dev');
  assert.equal(spec.Labels['arb-computer'], 'shop');
  assert.match(spec.Labels['arb-spec'], /^[0-9a-f]{16}$/);
  const h = spec.HostConfig;
  assert.equal(h.ReadonlyRootfs, true);
  assert.equal(h.Init, true, 'an init reaps zombies');
  assert.match(spec.Cmd[2], /rmSync\('\/home\/agent\/\.agent-browser\/profile\/'\+f/, 'stale Chrome lock dropped at start');
  assert.deepEqual(Object.keys(h.Tmpfs), ['/tmp', '/home/agent']);
  assert.equal(h.Privileged, undefined);
  assert.equal(h.Binds, undefined);
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
  assert.deepEqual(log.map((l) => l.method), ['GET', 'GET'], 'running computer: inspect only');

  containers.get('arb-shop')!.Labels!['arb-spec'] = 'older';
  log = [];
  await driver.ensure(id, { egressDir: '/unused' });
  assert.deepEqual(log.map((l) => `${l.method} ${l.url}`).slice(1, 5), [
    'GET /v1.47/containers/arb-shop/json', 'GET /v1.47/containers/arb-shop/json',
    'DELETE /v1.47/containers/arb-shop?force=true', 'POST /v1.47/volumes/create'], 'older spec: recreated, volume kept');
  assert.ok(!log.some((l) => l.method === 'DELETE' && l.url.includes('/volumes/')));

  // Same tag, new image (rebuilt or pulled on upgrade): recreated too, volume kept.
  imageId = 'sha256:bbb';
  log = [];
  await driver.ensure(id, { egressDir: '/unused' });
  assert.ok(log.some((l) => l.method === 'DELETE' && l.url === '/v1.47/containers/arb-shop?force=true'), 'new image: recreated');
  assert.ok(!log.some((l) => l.method === 'DELETE' && l.url.includes('/volumes/')));
  log = [];
  await driver.ensure(id, { egressDir: '/unused' });
  assert.deepEqual(log.map((l) => l.method), ['GET', 'GET'], 'then stable');
});

test('a container of the same name without our label is never touched', async () => {
  const other = parseProfileId('gateway-1')!;
  log = [];
  await assert.rejects(driver.ensure(other, { egressDir: '' }), /not a computer of this stack/);
  await assert.rejects(driver.exec(other, ['true'], { timeoutMs: 1000 }), /not a computer of this stack/);
  await assert.rejects(driver.stream(other), /not a computer of this stack/);
  await assert.rejects(driver.stop(other), /not a computer of this stack/);
  await assert.rejects(driver.remove(other, { keepVolume: false }), /not a computer of this stack/);
  assert.ok(log.every((l) => l.method === 'GET'), 'reads only');
  // No foreign container, but an unlabeled volume of the same name: not deleted either.
  containers.delete('arb-gateway-1');
  await assert.rejects(driver.remove(other, { keepVolume: false }), /not a profile volume of this stack/);
  assert.ok(volumes.has('arb-profile-gateway-1'));
});

test('exec: stdin sent then closed, stdout and stderr demuxed, exit code read', async () => {
  log = [];
  const r = await driver.exec(id, ['cat'], { stdin: 'secret', timeoutMs: 5000 });
  assert.deepEqual(r, { code: 3, stdout: 'got:secret', stderr: 'warn' });
  assert.equal(log[0].url, '/v1.47/containers/arb-shop/json');
  assert.deepEqual(log[1].body, { Cmd: ['timeout', '-k', '5', '5', 'cat'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false });
  assert.equal(log[2].url, '/v1.47/exec/e1/start');
});

test('list maps the prefix label; remove deletes container and volume', async () => {
  log = [];
  assert.deepEqual(await driver.list(), [{ id: 'shop', running: true, startedAt: 1000 }, { id: 'old', running: false, startedAt: 2000 }]);
  assert.deepEqual(JSON.parse(new URL('http://x' + log[0].url).searchParams.get('filters')!), { label: ['arb-computer'] });
  log = [];
  await driver.remove(id, { keepVolume: false });
  assert.deepEqual(log.map((l) => `${l.method} ${l.url}`),
    ['GET /v1.47/containers/arb-shop/json', 'DELETE /v1.47/containers/arb-shop?force=true',
      'GET /v1.47/volumes/arb-profile-shop', 'DELETE /v1.47/volumes/arb-profile-shop?force=true']);
  assert.equal(volumes.has('arb-profile-shop'), false);
});

test('copyVolume: read-only source, no network, throwaway container removed; never overwrites', async () => {
  log = [];
  volumes.delete('arb-profile-shop');
  assert.equal(await driver.copyVolume('ac-profile-shop', id), 'copied');
  assert.deepEqual(log.map((l) => `${l.method} ${l.url}`), [
    'GET /v1.47/volumes/ac-profile-shop',
    'GET /v1.47/volumes/arb-profile-shop',
    'POST /v1.47/images/create?fromImage=alpine&tag=sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f',
    'POST /v1.47/volumes/create',
    'POST /v1.47/containers/create?name=arb-migrate-shop',
    'POST /v1.47/containers/arb-migrate-shop/start',
    'POST /v1.47/containers/arb-migrate-shop/wait',
    'DELETE /v1.47/containers/arb-migrate-shop?force=true',
  ]);
  assert.deepEqual(log[3].body, { Name: 'arb-profile-shop', Labels: { 'arb-computer': 'shop' } });
  const spec = log[4].body;
  assert.deepEqual(spec.Cmd, ['cp', '-a', '/from/.', '/to/']);
  assert.equal(spec.Labels, undefined, 'not a computer: list() never sees it');
  assert.equal(spec.HostConfig.NetworkMode, 'none');
  assert.deepEqual(spec.HostConfig.Mounts, [
    { Type: 'volume', Source: 'ac-profile-shop', Target: '/from', ReadOnly: true },
    { Type: 'volume', Source: 'arb-profile-shop', Target: '/to' }]);

  log = [];
  assert.equal(await driver.copyVolume('ac-profile-shop', id), 'target exists');
  assert.equal(await driver.copyVolume('ac-profile-none', id), 'no source');
  assert.ok(log.every((l) => l.method === 'GET'), 'nothing created');
});

test('copyVolume: failed copy removes the container and the half-written target', async () => {
  volumes.delete('arb-profile-shop');
  copyExit = 1;
  log = [];
  await assert.rejects(driver.copyVolume('ac-profile-shop', id), /exited with 1/);
  assert.deepEqual(log.slice(-2).map((l) => `${l.method} ${l.url}`),
    ['DELETE /v1.47/containers/arb-migrate-shop?force=true', 'DELETE /v1.47/volumes/arb-profile-shop']);
  assert.equal(volumes.has('arb-profile-shop'), false);
  copyExit = 0;
});
