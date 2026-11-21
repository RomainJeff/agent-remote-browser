import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { urlAllowed, slug, validId, parseProfileId, validDomain, redirectUriOk, pkceOk, localRequest, windowBudget } from '../../src/policy.ts';

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

test('redirectUriOk: https anywhere, http loopback only, no fragment or credentials', () => {
  for (const u of ['https://www.notion.so/oauth/callback', 'http://localhost:3000/cb', 'http://127.0.0.1/cb', 'http://[::1]:9/cb'])
    assert.equal(redirectUriOk(u), true, u);
  for (const u of ['http://evil.com/cb', 'https://a.com/cb#x', 'https://example.com/cb#', 'javascript:alert(1)',
    'https://user@example.com/cb', 'https://a.com/c b', 'https://a.com/c\\b', 'https://a.com/' + 'x'.repeat(2048), 'not a url'])
    assert.equal(redirectUriOk(u), false, u);
});

test('pkceOk: S256 of a 43-128 char verifier', () => {
  const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
  const verifier = 'a'.repeat(43);
  assert.equal(pkceOk(verifier, s256(verifier)), true);
  assert.equal(pkceOk('b'.repeat(43), s256(verifier)), false);
  assert.equal(pkceOk(undefined, s256(verifier)), false);
  assert.equal(pkceOk('short', s256('short')), false);
  assert.equal(pkceOk('a'.repeat(129), s256('a'.repeat(129))), false);
  assert.equal(pkceOk(verifier, verifier), false); // "plain" method refused
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
