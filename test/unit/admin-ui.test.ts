// The built admin UI (npm run build:admin, run by pretest) in headless Chrome. Every API reply is a local fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dist = new URL('../../dist/admin/', import.meta.url);
const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));

const fixture = `
const writes = [];
let signedIn = false;
window.fetch = async (path, options = {}) => {
  const body = options.body && JSON.parse(options.body);
  if (body) writes.push([path, body]);
  const json = (value, status = 200) => ({ status, ok: status < 400, json: async () => value });
  switch (path) {
    case '/api/session': return signedIn ? json({ email: 'admin@example.test', stepUpRemainingS: 0 }) : json({ error: 'Sign in first' }, 401);
    case '/api/users': return json([]);
    case '/api/auth/sign-in/email': return body.password === 'right' ? json({ twoFactorRedirect: true }) : json({ message: 'Invalid' }, 401);
    case '/api/auth/two-factor/verify-totp': signedIn = body.code === '123456'; return signedIn ? json({}) : json({ message: 'Invalid' }, 401);
    case '/api/auth/sign-out': signedIn = false; return json({});
    case '/api/invite/start': return json({ totpURI: 'otpauth://fixture', qrSVG: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    case '/api/invite/finish': return body.code === '123456' ? json({ backupCodes: ['sample-backup'] }) : json({ error: 'Invalid code' }, 401);
    default: throw Error(path);
  }
};
const check = (ok, message) => { if (!ok) throw Error(message); };
const until = async (fn, message) => {
  for (let i = 0; i < 100; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw Error('timed out: ' + message);
};
const text = () => document.body.innerText;
const field = (name) => document.querySelector('[name="' + name + '"]');
const submit = (name, value) => { field(name).value = value; field(name).form.requestSubmit(); };`;

/** Serves the build with the fixture first in <head>, runs the scenario once the page loaded; PASS or the failure
 *  comes back in the document title. */
function browserCase(name: string, hash: string, scenario: string) {
  test(name, { skip: !chrome && 'Chrome or Chromium required' }, async () => {
    const index = readFileSync(new URL('index.html', dist), 'utf8').replace('<head>', () => `<head><script>${fixture}
      addEventListener('load', async () => {
        try { ${scenario}; document.title = 'PASS'; } catch (e) { document.title = 'FAIL ' + e.message; }
      });</script>`);
    const server = createServer((req, res) => {
      const path = req.url!.split('?')[0];
      if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(index);
      const file = new URL('.' + path, dist);
      if (!path.startsWith('/assets/') || !existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(readFileSync(file));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const dir = mkdtempSync(join(tmpdir(), 'arb-ui-'));
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn(chrome!, ['--headless', '--disable-gpu', '--disable-background-networking', '--user-data-dir=' + join(dir, 'browser'),
          '--dump-dom', '--virtual-time-budget=10000', `http://127.0.0.1:${(server.address() as AddressInfo).port}/${hash}`]);
        let stdout = '';
        p.stdout.on('data', (d) => { stdout += d; });
        p.on('error', reject);
        p.on('close', () => resolve(stdout));
      });
      assert.equal(out.match(/<title>([^<]*)<\/title>/)?.[1], 'PASS');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

browserCase('a signed-out visit signs in with password then code, opens the console, and signs out', '#/profiles', `
  await until(() => field('password'), 'sign-in form');
  field('email').value = 'admin@example.test';
  submit('password', 'wrong');
  await until(() => document.querySelector('[role=alert]')?.textContent === 'Wrong email or password.', 'password error');
  submit('password', 'right');
  await until(() => field('code'), 'code form');
  submit('code', '000000');
  await until(() => document.querySelector('[role=alert]')?.textContent.startsWith('Invalid or expired code'), 'code error');
  submit('code', '123456');
  await until(() => document.querySelector('h1')?.textContent === 'Profiles', 'console');
  check(text().includes('admin@example.test') && text().includes('Members'), 'account and Members navigation');
  check(document.querySelector('[aria-current=page]').textContent === 'Profiles', 'current page');
  document.querySelector('[aria-label="Sign out"]').click();
  await until(() => field('password'), 'back to sign-in');
  check(JSON.stringify(writes.map(w => w[0])) === JSON.stringify(['/api/auth/sign-in/email', '/api/auth/sign-in/email',
    '/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-totp', '/api/auth/sign-out']), 'requests ' + JSON.stringify(writes));
  check(writes[3][1].trustDevice === false, 'device not trusted by default');
`);

browserCase('invite enrollment keeps an invalid code on screen, then shows backup codes once', '#/invite/sample', `
  await until(() => field('password'), 'password step');
  submit('password', 'test-password');
  await until(() => document.querySelector('textarea')?.value === 'otpauth://fixture', 'authenticator URI');
  check(document.querySelector('[aria-current=step]').textContent.endsWith('Authenticator'), 'current step');
  submit('code', '000000');
  await until(() => document.querySelector('[role=alert]')?.textContent === 'Invalid code', 'API error');
  submit('code', '123456');
  await until(() => text().includes('sample-backup'), 'backup codes');
  [...document.querySelectorAll('a')].find(a => a.textContent === 'Sign in').click();
  await until(() => field('email'), 'sign-in');
  check(!text().includes('sample-backup'), 'codes gone');
  check(JSON.stringify(writes) === JSON.stringify([
    ['/api/invite/start', { token: 'sample', password: 'test-password' }],
    ['/api/invite/finish', { token: 'sample', code: '000000' }], ['/api/invite/finish', { token: 'sample', code: '123456' }],
  ]), 'invite requests');
`);
