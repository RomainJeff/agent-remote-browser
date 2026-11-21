// The runner's trust boundary: what a compromised gateway may send it. Schema first, then the socket end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Request, AB_FLAGS, SESSION, MAX_REQUEST } from '../../src/runner/protocol.ts';
import { serveRunner } from '../../src/runner/server.ts';
import { RunnerDriver } from '../../src/host/runner.ts';
import { FakeDriver } from '../../src/host/fake.ts';
import { parseProfileId } from '../../src/policy.ts';

const ab = (...a: string[]) => ['agent-browser', ...AB_FLAGS, ...a];
const exec = (argv: string[], extra = {}) => ({ op: 'exec', id: 'shop', argv, timeoutMs: 5000, ...extra });
const ok = (r: unknown) => Request.safeParse(r).success;

test('requests carry a profile id and nothing else: no image, mount, container name or host option', () => {
  assert.ok(ok({ op: 'ensure', id: 'shop' }));
  for (const extra of [{ Image: 'alpine' }, { image: 'evil:latest' }, { Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] },
    { binds: ['/:/host'] }, { HostConfig: { Privileged: true } }, { name: 'arb-gateway-1' }, { egressDir: '/var/run' }])
    assert.equal(ok({ op: 'ensure', id: 'shop', ...extra }), false, JSON.stringify(extra));
  assert.equal(ok({ op: 'run', id: 'shop' }), false, 'unknown op');
  assert.equal(ok({ op: 'list', id: 'shop' }), false);
  assert.equal(ok({ op: 'remove', id: 'shop' }), false, 'keepVolume is explicit');
  assert.equal(ok({ op: 'copyVolume', id: 'shop', from: 'arb-data' }), false, 'the runner picks the source');
});

test('profile ids: the policy regex, so no path, no uppercase, no leading dash, at most 40', () => {
  for (const id of ['shop', 'a', 'shop-2', 'x'.repeat(40)]) assert.ok(ok({ op: 'stop', id }), id);
  for (const id of ['../x', 'a/b', 'A', '-x', 'x'.repeat(41), '', 'a b', 'a_b', 'shop\n', 1, null])
    assert.equal(ok({ op: 'stop', id }), false, String(id));
});

test('exec: only the agent-browser shapes the gateway uses, with its fixed flags', () => {
  for (const a of [ab('open', 'https://example.com/a?b=1'), ab('snapshot', '-i'), ab('get', 'text', '@e12'), ab('get', 'text', 'body'),
    ab('get', 'url'), ab('click', '@e1'), ab('fill', '@e1', '--', '-starts with a dash'), ab('press', 'Enter'), ab('press', '-'),
    ab('back'), ab('screenshot'), ab('close'), ab('stream', 'status'),
    ab('auth', 'save', 'gw-shop-1', '--url', 'https://example.com/login', '--username', 'me@example.test', '--password-stdin'),
    ab('auth', 'login', 'gw-shop-1'), ab('auth', 'delete', 'gw-shop-1'),
    ['base64', '-w0', '/tmp/shot.png'], ['rm', '-f', '/home/agent/.agent-browser/tmp/s-1.png'], ['cat', SESSION]])
    assert.ok(ok(exec(a)), a.join(' '));
  for (const a of [['sh', '-c', 'id'], ['agent-browser', 'open', 'https://example.com'], ab('eval', '1'),
    ['agent-browser', ...AB_FLAGS.slice(0, -1), '--no-sandbox', 'open', 'https://example.com'],
    ab('open', 'file:///etc/passwd'), ab('open', 'javascript:alert(1)'), ab('open', 'https://example.com', '--extra'),
    ab('press', '--foo'), ab('click', 'e1'), ab('fill', '@e1', 'no separator'),
    ab('auth', 'save', 'gw-x', '--url', 'http://example.com', '--username', 'u', '--password-stdin'),
    ab('auth', 'save', 'gw-x', '--url', 'https://example.com', '--username', '--password', '--password-stdin'),
    ab('auth', 'login', 'someone-else'),
    ['cat', '/etc/shadow'], ['cat', '/home/agent/.agent-browser/../../../etc/shadow'], ['base64', '-w0', '/etc/x.png'],
    ['base64', '-w0', '/tmp/../etc/x.png'], ['rm', '-rf', '/tmp/x.png'], ['rm', '-f', '/tmp/x.png', '/tmp/y.png'],
    ab('get', 'text', 'body\0'), ab('fill', '@e1', '--', 'x'.repeat(5001)), []])
    assert.equal(ok(exec(a)), false, a.join(' '));
  assert.equal(ok(exec(ab('close'), { timeoutMs: 999 })), false);
  assert.equal(ok(exec(ab('close'), { timeoutMs: 120_001 })), false);
  assert.equal(ok(exec(ab('close'), { stdin: 'x'.repeat(4097) })), false);
  assert.equal(ok(exec(ab('close'), { tty: true })), false);
});

const dir = mkdtempSync(join(tmpdir(), 'arb-run-'));
const path = join(dir, 'runner.sock');
const fake = new FakeDriver();
let server: net.Server;
before(async () => { server = await serveRunner(fake, path); });
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

/** Raw request line(s) as a compromised gateway could send them; resolves with everything the runner wrote back. */
const raw = (data: string | Buffer) => new Promise<string>((resolve) => {
  let out = '';
  const s = net.connect(path).on('data', (d) => { out += d; }).on('close', () => resolve(out)).on('error', () => {});
  s.write(data);
});

test('socket: owner-only, invalid requests reach no driver call', async () => {
  assert.equal(statSync(path).mode & 0o777, 0o600);
  fake.calls = [];
  for (const line of ['not json', '{"op":"ensure","id":"../x"}', JSON.stringify({ op: 'ensure', id: 'shop', Image: 'x' }),
    JSON.stringify(exec(['sh', '-c', 'id']))])
    assert.deepEqual(JSON.parse(await raw(line + '\n')), { ok: false, error: 'invalid request' }, line);
  assert.equal(await raw(Buffer.alloc(MAX_REQUEST + 2, 'a')), '', 'oversized line: connection dropped');
  assert.deepEqual(fake.calls, []);
});

test('RunnerDriver round trip; copyVolume source forced to the POC volume of the same id', async () => {
  const r = new RunnerDriver(path), id = parseProfileId('shop')!;
  fake.calls = [];
  assert.equal((await r.ensure(id, { egressDir: '/ignored' })).id, 'shop');
  assert.deepEqual(await r.exec(id, ['base64', '-w0', '/tmp/s.png'], { timeoutMs: 5000 }), { code: 0, stdout: 'iVBORw0K', stderr: '' });
  assert.deepEqual(await r.list(), [{ id: 'shop', running: true, startedAt: fake.computers.get('shop')!.startedAt }]);
  assert.equal(await r.copyVolume(id), 'copied');
  await assert.rejects(r.exec(id, ['cat', '/etc/shadow'], { timeoutMs: 5000 }), /invalid request/);
  await r.remove(id, { keepVolume: false });
  assert.deepEqual(fake.calls.map((c) => c.op), ['ensure', 'exec', 'list', 'copyVolume', 'remove']);
  assert.deepEqual(fake.calls[3], { op: 'copyVolume', id: 'shop', from: 'ac-profile-shop' });
});
