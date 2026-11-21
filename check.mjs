// Self-check for the security-relevant policy logic: `node check.mjs`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { urlAllowed, slug, validId, validDomain, redirectUriOk, pkceOk } from './policy.mjs';

const allow = ['example.com'];
assert.equal(urlAllowed('https://example.com/x', allow), true);
assert.equal(urlAllowed('https://www.example.com', allow), true);
assert.equal(urlAllowed('https://evilexample.com', allow), false);
assert.equal(urlAllowed('https://example.com.evil.io', allow), false);
assert.equal(urlAllowed('file:///etc/passwd', allow), false);
assert.equal(urlAllowed('javascript:alert(1)', allow), false);
assert.equal(urlAllowed('http://169.254.169.254/', allow), false);
assert.equal(urlAllowed('not a url', allow), false);

assert.equal(slug('Notion Veille/1'), 'notion-veille-1');

assert.equal(validId('notion-demo'), true);
assert.equal(validId('__proto__'), false);
assert.equal(validId('-x'), false);
assert.equal(validId('A'), false);
assert.equal(validDomain('the-internet.herokuapp.com'), true);
assert.equal(validDomain('localhost'), false);
assert.equal(validDomain('1.2.3.4'), false);
assert.equal(validDomain('a.com, *'), false);

assert.equal(redirectUriOk('https://www.notion.so/oauth/callback'), true);
assert.equal(redirectUriOk('http://localhost:3000/cb'), true);
assert.equal(redirectUriOk('http://evil.com/cb'), false);
assert.equal(redirectUriOk('https://a.com/cb#x'), false);
assert.equal(redirectUriOk('javascript:alert(1)'), false);

const verifier = 'a'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
assert.equal(pkceOk(verifier, challenge), true);
assert.equal(pkceOk('b'.repeat(43), challenge), false);
assert.equal(pkceOk(undefined, challenge), false);
assert.equal(pkceOk('short', createHash('sha256').update('short').digest('base64url')), false);

const {publicIPv4} = await import('./egress.mjs');
for (const address of ['::1','127.0.0.1','10.2.3.4','172.17.0.1','169.254.169.254','192.168.1.1','100.64.0.1','224.0.0.1']) assert.equal(publicIPv4(address),false);
assert.equal(publicIPv4('8.8.8.8'),true);
assert.equal(urlAllowed('http://host.docker.internal',['docker.internal']),false);
assert.equal(urlAllowed('https://user@example.com',allow),false);

const fs = await import('node:fs');
const {tmpdir} = await import('node:os');
const scratch = fs.mkdtempSync(tmpdir()+'/ac-check-');
try {
  process.env.LOGIN_KEY_FILE = scratch+'/key';
  process.env.STATE_FILE = scratch+'/state';
  // Empty fixture exercises the legacy string representation without writing a credential.
  const legacy = {url:'https://example.com',username:'fixture',password:''};
  fs.writeFileSync(process.env.STATE_FILE,JSON.stringify({profiles:{fixture:{logins:{site:legacy}}}}));
  const {encryptLogin,decryptLogin} = await import('./store.mjs');
  const saved = JSON.parse(fs.readFileSync(process.env.STATE_FILE)).profiles.fixture.logins.site;
  assert.equal(typeof saved.password,'object');
  assert.ok(decryptLogin('fixture','site',saved) === '');
  assert.equal(fs.statSync(process.env.LOGIN_KEY_FILE).mode & 0o777,0o600);
  assert.equal(fs.statSync(process.env.STATE_FILE).mode & 0o777,0o600);
  const c = {url:'https://example.com',username:'fixture'};
  const sample = createHash('sha256').update(String(Math.random())).digest('hex');
  c.password = encryptLogin('id','site',c,sample);
  assert.ok(decryptLogin('id','site',c) === sample);
  assert.throws(()=>decryptLogin('id','other',c));
  fs.unlinkSync(process.env.LOGIN_KEY_FILE);
  await assert.rejects(import('./store.mjs?missing-key'),/Restore the existing login key/);
  assert.equal(fs.existsSync(process.env.LOGIN_KEY_FILE),false);
} finally { fs.rmSync(scratch,{recursive:true,force:true}); }
const {localRequest} = await import('./policy.mjs');
const host = '127.0.0.1:8788';
assert.ok(localRequest({host,origin:'http://'+host},8788));
for (const h of [{host:'foreign.test:8788'},{host,origin:'http://localhost:3000'},{host,'sec-fetch-site':'cross-site'}])
  assert.equal(localRequest(h,8788),false);
const {windowBudget} = await import('./policy.mjs');
const take = windowBudget(2,1000);
assert.deepEqual([take(1),take(2),take(3),take(1001)],[true,true,false,true]);
assert.equal(redirectUriOk('https://user@example.com/cb'),false);
assert.equal(redirectUriOk('https://example.com/cb#'),false);

console.log('ok');
