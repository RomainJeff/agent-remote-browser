import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canDrive, needs, type Role, urlAllowed, slug, validId, parseProfileId, validDomain, localRequest, windowBudget } from '../../src/policy.ts';

test('urlAllowed: exact domain or subdomain, http(s) only, no credentials or port', () => {
  const allow = ['example.com'];
  for (const u of ['https://example.com/x', 'https://www.example.com', 'http://example.com', 'https://EXAMPLE.com/'])
    assert.equal(urlAllowed(u, allow), true, u);
  for (const u of ['https://evilexample.com', 'https://example.com.evil.io', 'file:///etc/passwd', 'javascript:alert(1)',
    'http://169.254.169.254/', 'not a url', 'https://user@example.com', 'https://u:p@example.com', 'https://example.com:8443/',
    'ftp://example.com', 'ws://example.com', 'https://localhost/', 'https://127.0.0.1/'])
    assert.equal(urlAllowed(u, allow), false, u);
  assert.equal(urlAllowed('http://host.docker.internal', ['docker.internal']), false);
  assert.equal(urlAllowed('https://example.com', []), false);
});

test('slug and validId', () => {
  assert.equal(slug('Notion Veille/1'), 'notion-veille-1');
  assert.equal(slug('x'.repeat(60)).length, 40);
  for (const id of ['notion-demo', 'a', '0', 'a'.repeat(40)]) assert.equal(validId(id), true, id);
  for (const id of ['__proto__', '-x', 'A', '', 'a'.repeat(41), '../x', 'a b', 'a.b', 42, null, undefined])
    assert.equal(validId(id), false, String(id));
  assert.equal(parseProfileId('shop'), 'shop');
  assert.equal(parseProfileId('../x'), null);
});

test('validDomain refuses IPs, internal TLDs and lists', () => {
  for (const d of ['the-internet.herokuapp.com', 'example.com', 'a.b.co']) assert.equal(validDomain(d), true, d);
  for (const d of ['localhost', '1.2.3.4', 'a.com, *', '*.example.com', 'example', 'foo.local', 'x.internal', 'nas.lan',
    'router.home.arpa', 'Example.com', 'example.com.', '', 7])
    assert.equal(validDomain(d), false, String(d));
});

test('localRequest: loopback Host on the admin port, same-origin only', () => {
  const host = '127.0.0.1:8788';
  assert.equal(localRequest({ host }, 8788), true);
  assert.equal(localRequest({ host, origin: 'http://' + host }, 8788), true);
  assert.equal(localRequest({ host: 'localhost:8788', 'sec-fetch-site': 'same-origin' }, 8788), true);
  for (const h of [{ host: 'foreign.test:8788' }, { host: '127.0.0.1:9999' }, { host, origin: 'http://localhost:3000' },
    { host, origin: 'null' }, { host, 'sec-fetch-site': 'cross-site' }, { host, 'sec-fetch-site': 'same-site' }, {}])
    assert.equal(localRequest(h, 8788), false, JSON.stringify(h));
});

test('windowBudget: fixed window counter', () => {
  const take = windowBudget(2, 1000);
  assert.deepEqual([take(1), take(2), take(3), take(1000), take(1001), take(1002), take(1003)], [true, true, false, false, true, true, false]);
});

test('profile actions require the specified role or higher', () => {
  const matrix: [Role, (string | null)[], (Role | null)[]][] = [
    ['viewer', [null, 'start', 'handoff-take', 'handoff-done', 'handoff-fail'], ['viewer', 'editor', 'admin']],
    ['editor', ['stop', 'open', 'paste', 'copy', 'config', 'login-save', 'login-test', 'login-fill', 'login-delete',
      'header-save', 'header-delete', 'playbook-save', 'playbook-delete', 'release', 'extend',
      'teach-click', 'teach-focus', 'teach-type', 'teach-press', 'teach-open', 'teach-read', 'teach-replay'], ['editor', 'admin']],
    ['admin', ['delete', 'members'], ['admin']],
  ];
  for (const [required, actions, allowed] of matrix) for (const action of actions) {
    assert.equal(needs(action), required, String(action));
    for (const role of [null, 'viewer', 'editor', 'admin'] as const)
      assert.equal(can(role, action), allowed.includes(role), `${role} / ${action}`);
  }
});

test('live input follows the current profile role, lease and handoff', () => {
  for (const leased of [true, false]) for (const taken of [true, false]) {
    assert.equal(canDrive(null, leased, taken), false);
    assert.equal(canDrive('viewer', leased, taken), taken);
    for (const role of ['editor', 'admin'] as const) assert.equal(canDrive(role, leased, taken), !leased || taken);
  }
});
