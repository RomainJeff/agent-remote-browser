// The runner's trust boundary: what a compromised gateway may send it. Schema first, then the socket end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Request, AB_FLAGS, SESSION, SELECTION, MAX_REQUEST } from '../../src/runner/protocol.ts';
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
  assert.equal(ok({ op: 'copyVolume', id: 'shop' }), false, 'no volume copy');
});

test('profile ids: the policy regex, so no path, no uppercase, no leading dash, at most 40', () => {
  for (const id of ['shop', 'a', 'shop-2', 'x'.repeat(40)]) assert.ok(ok({ op: 'stop', id }), id);
  for (const id of ['../x', 'a/b', 'A', '-x', 'x'.repeat(41), '', 'a b', 'a_b', 'shop\n', 1, null])
    assert.equal(ok({ op: 'stop', id }), false, String(id));
});

test('exec: only the agent-browser shapes the gateway uses, with its fixed flags', () => {
  for (const a of [ab('open', 'https://example.com/a?b=1'), ab('snapshot', '-i'), ab('snapshot', '-i', '-c'),
    ab('snapshot', '-i', '-s', '#main'), ab('snapshot', '-i', '-c', '-s', 'main .usage > p'), ab('get', 'text', '@e12'), ab('get', 'text', '#usage'), ab('get', 'text', 'body'),
    ab('get', 'url'), ab('click', '@e1'), ab('fill', '@e1', '--', '-starts with a dash'), ab('press', 'Enter'), ab('press', '-'),
    ab('back'), ab('screenshot'), ab('close'), ab('stream', 'status'),
    ab('keyboard', 'inserttext', 'two\nlines'), ab('keyboard', 'inserttext', '-'), ab('eval', SELECTION),
    ab('auth', 'save', 'gw-shop-1', '--url', 'https://example.com/login', '--username', 'me@example.test', '--password-stdin'),
    ab('auth', 'login', 'gw-shop-1'), ab('auth', 'login', 'gw-shop-1', '--no-navigate'), ab('auth', 'delete', 'gw-shop-1'),
    ['base64', '-w0', '/tmp/shot.png'], ['rm', '-f', '/home/agent/.agent-browser/tmp/s-1.png'], ['cat', SESSION]])
    assert.ok(ok(exec(a)), a.join(' '));
  for (const a of [['sh', '-c', 'id'], ['agent-browser', 'open', 'https://example.com'], ab('eval', '1'),
    ['agent-browser', ...AB_FLAGS.slice(0, -1), '--no-sandbox', 'open', 'https://example.com'],
    ab('open', 'file:///etc/passwd'), ab('open', 'javascript:alert(1)'), ab('open', 'https://example.com', '--extra'),
    ab('press', '--foo'), ab('click', 'e1'), ab('keyboard', 'inserttext', '--json'), ab('keyboard', 'inserttext', 'x'.repeat(5001)),
    ab('keyboard', 'type', 'x'), ab('eval', SELECTION + ';1'), ab('fill', '@e1', 'no separator'),
    ab('auth', 'save', 'gw-x', '--url', 'http://example.com', '--username', 'u', '--password-stdin'),
    ab('auth', 'save', 'gw-x', '--url', 'https://example.com', '--username', '--password', '--password-stdin'),
    ab('auth', 'login', 'someone-else'), ab('auth', 'login', 'gw-x', '--url', 'https://evil.test'), ab('auth', 'delete', 'gw-x', '--no-navigate'),
    ['cat', '/etc/shadow'], ['cat', '/home/agent/.agent-browser/../../../etc/shadow'], ['base64', '-w0', '/etc/x.png'],
    ['base64', '-w0', '/tmp/../etc/x.png'], ['rm', '-rf', '/tmp/x.png'], ['rm', '-f', '/tmp/x.png', '/tmp/y.png'],
    ab('get', 'text', 'body\0'), ab('get', 'text', '--json'), ab('get', 'text', '-'), ab('snapshot', '-i', '-s', '--delta'),
    ab('snapshot', '--delta'), ab('snapshot', '-i', '-s'), ab('snapshot', '-i', '-s', 'x'.repeat(501)), ab('snapshot', '-i', '-d', '3'), ab('fill', '@e1', '--', 'x'.repeat(5001)), []])
    assert.equal(ok(exec(a)), false, a.join(' '));
  assert.equal(ok(exec(ab('close'), { timeoutMs: 999 })), false);
  assert.equal(ok(exec(ab('close'), { timeoutMs: 120_001 })), false);
  assert.equal(ok(exec(ab('close'), { stdin: 'x'.repeat(4097) })), false);
  assert.equal(ok(exec(ab('close'), { tty: true })), false);
});

test('exec: run_steps find, wait and get count, strictly (no --fn, no other find action, no flag as a value)', () => {
  for (const a of [ab('find', 'text', 'Sign in', 'click'), ab('find', 'text', 'Sign in', 'click', '--exact'),
    ab('find', 'label', 'Email', 'fill', 'me@x.test'), ab('find', 'placeholder', 'you@x', 'fill', 'zz', '--exact'),
    ab('find', 'testid', 'go', 'click'), ab('find', 'first', 'main h1', 'click'), ab('find', 'role', 'button', 'click'),
    ab('find', 'role', 'button', 'click', '--name', 'Go'), ab('find', 'role', 'textbox', 'fill', 'x', '--name', 'Email', '--exact'),
    ab('wait', '300'), ab('wait', '5000'), ab('wait', '#out'), ab('wait', '--text', 'Welcome'), ab('wait', '--url', '**/dashboard'),
    ab('wait', '--load', 'networkidle'), ab('wait', '--text', 'Welcome', '--timeout', '17500'), ab('wait', '#out', '--timeout', '999'),
    ab('wait', '--load', 'load', '--timeout', '500'), ab('get', 'count', 'input[type=password]')])
    assert.ok(ok(exec(a)), a.join(' '));
  for (const a of [ab('find', 'text', '--json', 'click'), ab('find', 'text', 'x', 'hover'), ab('find', 'nth', '2', 'a', 'click'),
    ab('find', 'alt', 'x', 'click'), ab('find', 'label', 'x', 'fill', '--json'), ab('find', 'label', 'x', 'fill'),
    ab('find', 'testid', 'x', 'click', '--exact'), ab('find', 'first', '-x', 'click'), ab('find', 'role', 'Button', 'click'),
    ab('find', 'role', 'button', 'click', '--exact'), ab('find', 'role', 'button', 'click', '--name', '--json'),
    ab('find', 'text', 'x', 'click', '--exact', '--exact'), ab('find', 'text', 'x', 'fill', 'y'.repeat(5001)),
    ab('wait', '--fn', 'x'), ab('wait', '--fn', 'window.done'), ab('wait', '99999'), ab('wait', '5001'), ab('wait', '0'), ab('wait', '1e3'),
    ab('wait', '--text', '--json'), ab('wait', '--load', 'idle'), ab('wait', '--download'), ab('wait'), ab('wait', '#a', '#b'),
    ab('wait', '300', '--timeout', '1000'), ab('wait', '#a', '--timeout', '99'), ab('wait', '#a', '--timeout', '20001'),
    ab('wait', '#a', '--timeout', '-1'), ab('wait', '#a', '--timeout'), ab('wait', '--text', 'x', '--state', 'hidden'),
    ab('get', 'count', 'input'), ab('get', 'count', 'input[type=password]', '--json')])
    assert.equal(ok(exec(a)), false, a.join(' '));
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

test('RunnerDriver round trip', async () => {
  const r = new RunnerDriver(path), id = parseProfileId('shop')!;
  fake.calls = [];
  assert.equal((await r.ensure(id, { egressDir: '/ignored' })).id, 'shop');
  assert.deepEqual(await r.exec(id, ['base64', '-w0', '/tmp/s.png'], { timeoutMs: 5000 }), { code: 0, stdout: 'iVBORw0K', stderr: '' });
  assert.deepEqual(await r.list(), [{ id: 'shop', running: true, startedAt: fake.computers.get('shop')!.startedAt }]);
  await assert.rejects(r.exec(id, ['cat', '/etc/shadow'], { timeoutMs: 5000 }), /invalid request/);
  await r.remove(id, { keepVolume: false });
  assert.deepEqual(fake.calls.map((c) => c.op), ['list', 'ensure', 'exec', 'list', 'remove'], 'ensure counts first');
});

test('MAX_COMPUTERS: concurrent starts cannot pass the cap; running ones and starts after a stop still go through', async () => {
  const p3 = join(dir, 'runner3.sock'), s3 = await serveRunner(fake, p3, { maxComputers: 2 });
  const r = new RunnerDriver(p3), id = (s: string) => parseProfileId(s)!;
  fake.computers.clear();
  const results = await Promise.all(['a', 'b', 'c'].map((x) => r.ensure(id(x), { egressDir: '' }).then(() => 'ok', (e: Error) => e.message)));
  assert.deepEqual(results, ['ok', 'ok', 'Too many computers running (MAX_COMPUTERS=2)']);
  assert.equal((await r.ensure(id('a'), { egressDir: '' })).id, 'a', 'already running: not counted twice');
  await r.stop(id('a'));
  assert.equal((await r.ensure(id('c'), { egressDir: '' })).id, 'c');
  await assert.rejects(r.ensure(id('a'), { egressDir: '' }), /MAX_COMPUTERS/);
  fake.computers.clear();
  s3.close();
});
