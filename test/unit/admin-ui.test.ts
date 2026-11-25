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
const writes = [], email = 'admin@example.test';
let signedIn = false, trusted = false, gatewayAdmin = true, role = 'admin', stepUpLeft = 0;
const computer = (id, extra) => ({ id, role: 'admin', members: 1, container: 'arb-' + id, state: 'none', status: 'never started', profile: false,
  allow: ['example.com'], logins: [], leasedUntil: null, lastCall: null, idleStopInS: null, viewers: 0, handoff: null, ...extra });
let computers = [computer('sample', { state: 'running', status: 'running', profile: true, logins: ['notion'] }), computer('other', { allow: ['notion.so'] })];
let members = [{ email, role: 'admin' }];
const user = (e, extra) => ({ email: e, admin: false, twoFactorEnabled: true, createdAt: '2026-01-01', pending: false, privateProfileCount: 0, ...extra });
let users = [user(email, { admin: true })], keys = [];
const SENSITIVE = ['config', 'login-save', 'login-delete', 'header-save', 'header-delete', 'playbook-save', 'playbook-delete', 'delete', 'members'];
window.fetch = async (path, options = {}) => {
  const body = options.body && JSON.parse(options.body);
  if (body) writes.push([path, body]);
  const json = (value, status = 200) => ({ status, ok: status < 400, json: async () => value });
  const m = path.match(/^\\/api\\/computers\\/([^/]+)(?:\\/(.+))?$/);
  if (m) {
    const [, id, act] = m;
    if (options.method === 'POST' && SENSITIVE.includes(act) && !stepUpLeft) return json({ stepUp: true, error: 'Confirm with a 2FA code first' }, 401);
    if (!act) return json({ id, running: true, page: null, headers: [], cookies: [], storage: [], audit: [],
      playbooks: [{ name: 'check-quota', description: 'Check quota', updated: new Date().toISOString(), body: '# Check quota\\n\\n\\u0060\\u0060\\u0060json\\n{"steps": [\\n  {"open": "https://example.com"}\\n]}\\n\\u0060\\u0060\\u0060' }],
      logins: [{ site: 'notion', url: 'https://www.notion.so/login', username: 'me', lastTestedAt: null, lastResult: null }] });
    if (act === 'members' && body) { members = body.role ? [...members.filter(x => x.email !== body.email), { email: body.email, role: body.role }] : members.filter(x => x.email !== body.email); return json({ role: body.role }); }
    if (act === 'members') return json(members);
    if (act === 'candidates') return json(['new@example.com', 'third@example.com']);
    if (act === 'config') { computers = computers.map(c => c.id === id ? { ...c, allow: body.allow } : c); return json({}); }
    if (act === 'delete') { computers = computers.filter(c => c.id !== id); return json({ deleted: true }); }
    if (act === 'start') return json({});
    if (act === 'playbook-save') return json({ created: false });
    if (act === 'handoff-take') { computers = computers.map(c => c.id === id ? { ...c, handoff: { ...c.handoff, state: 'taken' } } : c); return json({ state: 'taken' }); }
    if (act === 'handoff-done') { computers = computers.map(c => c.id === id ? { ...c, handoff: null } : c); return json({}); }
    if (act === 'teach-click') return json({ step: { click: { text: 'OK' } }, field: false });
    throw Error(path);
  }
  switch (path) {
    case '/api/session': return signedIn ? json({ email, stepUpRemainingS: stepUpLeft, mcpUrl: 'https://arb.example.test/mcp' }) : json({ error: 'Sign in first' }, 401);
    case '/api/users': return gatewayAdmin ? json(users) : json({ error: 'forbidden' }, 403);
    case '/api/users/invites': return json([]);
    case '/api/users/invite': return json({ link: 'https://arb.example.test/#/invite/sample' });
    case '/api/users/remove': users = users.filter(u => u.email !== body.email); return json({ removed: true });
    case '/api/keys': if (!stepUpLeft) return json({ stepUp: true, error: 'Confirm with a 2FA code first' }, 401);
      keys = [{ id: 'k1', name: body.name, start: 'arb_k_ab', scope: body.scope, createdAt: new Date().toISOString(), lastRequest: null, lastIp: null, expiresAt: '2027-02-23T00:00:00.000Z', noExpiry: false }];
      return json({ id: 'k1', key: 'arb_k_secret-fixture', expiresAt: '2027-02-23T00:00:00.000Z' }, 201);
    case '/api/computers': return json(computers.map(c => c.id === 'sample' ? { ...c, role } : c));
    case '/api/clients': return json({ keys, oauth: [] });
    case '/api/profiles': computers = [...computers, computer(body.id, { allow: body.allow })]; return json({ id: body.id }, 201);
    case '/api/step-up': if (body.code !== '123456') return json({ stepUp: true, error: 'Invalid code' }, 401); stepUpLeft = 900; return json({ stepUpRemainingS: 900 });
    case '/api/auth/sign-in/email': if (body.password !== 'right') return json({ message: 'Invalid' }, 401);
      signedIn = trusted; return json(trusted ? { token: 't', user: { email } } : { twoFactorRedirect: true });
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
const field = (name, root = document) => root.querySelector('[name="' + name + '"]');
const submit = (name, value) => { field(name).value = value; field(name).form.requestSubmit(); };
const button = (label, root = document) => [...root.querySelectorAll('button, a')].find(b => b.textContent.trim() === label);
const dialog = () => document.querySelector('[role=dialog] form');
/** Value change React sees (its value tracker ignores plain assignments). */
const choose = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const sent = () => JSON.stringify(writes);
// The stream: a socket the scenario drives, frames drawn on a canvas so the image really loads.
const sockets = [];
window.WebSocket = class { constructor(url) { this.url = url; this.sent = []; this.readyState = 1; sockets.push(this); } send(m) { this.sent.push(JSON.parse(m)); } close() { this.readyState = 3; } };
const frame = (seq) => {
  const c = document.createElement('canvas'); c.width = 40; c.height = 30;
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'frame', seq, data: c.toDataURL('image/jpeg').split(',')[1], metadata: { deviceWidth: 40 } }) });
};
const mouse = (type, el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); };`;

/** Serves the build with the fixture (then `setup`) first in <head>, runs the scenario once the page loaded; PASS or
 *  the failure comes back as data-result on <html>. */
function browserCase(name: string, hash: string, scenario: string, setup = '') {
  test(name, { skip: !chrome && 'Chrome or Chromium required' }, async () => {
    const index = readFileSync(new URL('index.html', dist), 'utf8').replace('<head>', () => `<head><script>${fixture}
      ${setup};
      addEventListener('load', async () => {
        const done = (r) => { document.documentElement.dataset.result = r; };
        try { ${scenario}; done('PASS'); } catch (e) { done('FAIL ' + e.message); }
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
      assert.equal(out.match(/data-result="([^"]*)"/)?.[1], 'PASS');
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
  check(document.querySelector('[aria-current=page]').textContent.startsWith('Profiles'), 'current page');
  document.querySelector('[aria-label="Sign out"]').click();
  await until(() => field('password'), 'back to sign-in');
  check(JSON.stringify(writes.map(w => w[0])) === JSON.stringify(['/api/auth/sign-in/email', '/api/auth/sign-in/email',
    '/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-totp', '/api/auth/sign-out']), 'requests ' + JSON.stringify(writes));
  check(writes[3][1].trustDevice === false, 'device not trusted by default');
`);

browserCase('a trusted device signs in with the password alone', '#/profiles', `
  await until(() => field('password'), 'sign-in form');
  field('email').value = 'admin@example.test';
  submit('password', 'right');
  await until(() => document.querySelector('h1')?.textContent === 'Profiles', 'console without a code');
  check(sent() === JSON.stringify([['/api/auth/sign-in/email', { email: 'admin@example.test', password: 'right' }]]), 'requests ' + sent());
`, 'trusted = true');

browserCase('invite enrollment keeps an invalid code on screen, then shows backup codes once', '#/invite/sample', `
  await until(() => field('password'), 'password step');
  field('confirm').value = 'test-passwrod';
  submit('password', 'test-password');
  await until(() => document.querySelector('[role=alert]')?.textContent === "Passwords don't match.", 'mismatch caught before any request');
  field('confirm').value = 'test-password';
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

browserCase('profiles list groups by driver and searches, and a new profile opens on its page', '#/profiles', `
  await until(() => text().includes('other'), 'profile rows');
  const rows = () => [...document.querySelectorAll('tbody tr:has(a)')].map(r => r.querySelector('a').textContent).join();
  const groups = () => [...document.querySelectorAll('tbody th')].map(t => t.textContent).join();
  check(rows() === 'sample,other' && groups() === 'Running1,Stopped1', 'grouped rows ' + rows() + ' ' + groups());
  choose(document.querySelector('[aria-label="Search profiles"]'), 'notion');
  await until(() => rows() === 'other', 'search by domain');
  button('New profile').click();
  await until(dialog, 'new profile dialog');
  field('id', dialog()).value = 'fresh';
  field('allow', dialog()).value = 'fresh.example\\nb.example';
  dialog().requestSubmit();
  await until(() => document.querySelector('h1')?.textContent.startsWith('fresh'), 'profile page');
  check(sent() === JSON.stringify([['/api/profiles', { id: 'fresh', allow: ['fresh.example', 'b.example'] }]]), 'create request ' + sent());
`, 'signedIn = true');

browserCase('viewer sees only Session, Diagnostics and Sharing, without Stop or Members', '#/profiles/sample', `
  await until(() => document.querySelector('nav[aria-label="Profile sections"]'), 'profile tabs');
  const tabs = [...document.querySelectorAll('nav[aria-label="Profile sections"] a')].map(a => a.textContent).join();
  check(tabs === 'Session,Diagnostics,Sharing', 'tabs ' + tabs);
  check(!button('Stop browser') && !button('Members'), 'no Stop, no Members');
`, "signedIn = true; role = 'viewer'; gatewayAdmin = false");

browserCase('editor asking for settings lands on the session, without Delete', '#/profiles/sample?tab=settings', `
  await until(() => document.querySelector('[aria-current=page][href*="sample"]'), 'current tab');
  const current = [...document.querySelectorAll('nav[aria-label="Profile sections"] [aria-current=page]')].map(a => a.textContent).join();
  check(current === 'Session', 'current tab ' + current);
  check(!button('Delete profile…') && button('Stop browser'), 'no Delete, Stop shown');
`, "signedIn = true; role = 'editor'");

browserCase('profile admin picks members to add, then changes and removes sharing', '#/profiles/sample?tab=sharing', `
  const form = await until(() => document.querySelector('details')?.closest('form'), 'share form');
  const pick = form.querySelector('details');
  await until(() => form.querySelectorAll('[name=email]').length === 2, 'candidates');
  form.requestSubmit();
  await until(() => pick.open, 'empty pick opens the list');
  check(writes.length === 0, 'nothing sent');
  for (const box of form.querySelectorAll('[name=email]')) box.click();
  await until(() => form.querySelector('summary').textContent === '2 selected', 'selection count');
  form.elements.role.value = 'viewer'; form.requestSubmit();
  await until(() => !pick.open && writes.length === 2, 'list closed after adding');
  await until(() => document.querySelector('[aria-label="Role of other@example.com"]'), 'other row');
  check(!document.querySelector('tbody tr:first-child button'), 'no Remove on own row');
  choose(document.querySelector('[aria-label="Role of ' + email + '"]'), 'editor');
  await until(() => writes.length === 3, 'role change');
  [...document.querySelectorAll('tbody tr')].find(r => r.textContent.includes('other@example.com')).querySelector('button').click();
  await until(() => writes.length === 4, 'removal');
  check(sent() === JSON.stringify([
    { email: 'new@example.com', role: 'viewer' }, { email: 'third@example.com', role: 'viewer' }, { email, role: 'editor' }, { email: 'other@example.com', role: null },
  ].map(body => ['/api/computers/sample/members', body])), 'membership requests ' + sent());
`, "signedIn = true; stepUpLeft = 900; members.push({ email: 'other@example.com', role: 'editor' })");

browserCase('deleting a profile asks to retype its name and for a 2FA code, then returns to the list', '#/profiles/sample?tab=settings', `
  (await until(() => button('Delete profile…'), 'delete button')).click();
  await until(dialog, 'confirm dialog');
  field('typed', dialog()).value = 'wrong'; field('code', dialog()).value = '123456'; dialog().requestSubmit();
  await until(() => dialog().innerText.includes('The text does not match.'), 'typed check');
  field('typed', dialog()).value = 'sample'; field('code', dialog()).value = '000000'; dialog().requestSubmit();
  await until(() => dialog().innerText.includes('Invalid code. Five wrong codes end the session.'), 'wrong code');
  field('code', dialog()).value = '123456'; dialog().requestSubmit();
  await until(() => document.querySelector('h1')?.textContent === 'Profiles' && text().includes('Profile sample deleted.'), 'back to the list');
  await until(() => ![...document.querySelectorAll('tbody a')].some(a => a.textContent === 'sample'), 'profile gone from the list');
  check(sent() === JSON.stringify([['/api/step-up', { code: '000000' }], ['/api/step-up', { code: '123456' }], ['/api/computers/sample/delete', {}]]), 'requests ' + sent());
`, 'signedIn = true');

browserCase('saving domains with a stale second factor asks for a code once, then retries', '#/profiles/sample?tab=domains', `
  const add = await until(() => document.querySelector('#newDomain'), 'domain form');
  add.value = 'New.example'; add.form.requestSubmit();
  await until(() => document.querySelector('[aria-label="Remove new.example"]'), 'chip added');
  document.querySelector('[aria-label="Remove example.com"]').click();
  await until(() => text().includes('2 unsaved changes'), 'draft');
  button('Save domains').click();
  await until(() => dialog()?.innerText.includes('Confirm with your 2FA code'), 'step-up dialog');
  field('code', dialog()).value = '123456'; dialog().requestSubmit();
  await until(() => text().includes('Domains saved. The browser restarts on next use.'), 'saved');
  check(sent() === JSON.stringify([['/api/computers/sample/config', { allow: ['new.example'] }], ['/api/step-up', { code: '123456' }],
    ['/api/computers/sample/config', { allow: ['new.example'] }]]), 'requests ' + sent());
  check(!text().includes('unsaved change'), 'draft cleared');
`, 'signedIn = true');

browserCase('playbook editor: edit in the form, check the Markdown, pause on an error, then save', '#/profiles/sample?tab=playbooks', `
  (await until(() => button('Edit'), 'playbook row')).click();
  await until(() => field('name')?.value === 'check-quota', 'loaded name');
  check(document.querySelector('#bdesc').value === 'Check quota', 'description');
  check(document.querySelectorAll('ol li').length === 1, 'one step');
  button('+ Add step').click();
  await until(() => document.querySelectorAll('ol li').length === 2, 'step added');
  choose(document.querySelector('ol li:nth-child(2) [aria-label="Text on the page"]'), 'Sign in');
  choose(document.querySelector('#bdesc'), 'Check the quota');
  const body = '# Check the quota\\n\\n\\u0060\\u0060\\u0060json\\n{"steps": [\\n  {"open": "https://example.com"},\\n  {"click": {"text": "Sign in"}}\\n]}\\n\\u0060\\u0060\\u0060';
  document.querySelector('input[value=md]').click();
  const md = await until(() => document.querySelector('[aria-label="Playbook Markdown"]'), 'markdown');
  check(md.value === body, 'markdown ' + JSON.stringify(md.value));
  choose(md, '# x\\n\\u0060\\u0060\\u0060json\\n{"steps": [\\n\\u0060\\u0060\\u0060');
  document.querySelector('input[value=form]').click();
  await until(() => text().includes('the form is paused: invalid JSON'), 'paused');
  check(document.querySelector('#bdesc').closest('fieldset').disabled, 'form disabled');
  document.querySelector('input[value=md]').click();
  choose(await until(() => document.querySelector('[aria-label="Playbook Markdown"]'), 'markdown again'), body);
  button('Save').click();
  await until(() => text().includes('Playbook check-quota updated.'), 'saved');
  check(!field('name') && text().includes('Open example.com'), 'editor closed, the playbook steps as sentences');
  check(sent() === JSON.stringify([['/api/computers/sample/playbook-save', { name: 'check-quota', body }]]), 'save request ' + sent());
`, 'signedIn = true; stepUpLeft = 900');

browserCase('live view: watch a running browser, take over, send a click, hand back', '#/profiles/sample', `
  (await until(() => button('Watch'), 'Watch button')).click();
  await until(() => sockets.length === 1, 'stream opened');
  check(sockets[0].url.endsWith('/api/computers/sample/stream?pacing=ack&maxFps=20'), 'stream URL ' + sockets[0].url);
  check(text().includes('Connecting…'), 'waiting for the first frame');
  frame(1);
  const img = await until(() => document.querySelector('#frame:not([hidden])'), 'first frame shown');
  await until(() => sockets[0].sent.some(m => m.type === 'ack' && m.seq === 1), 'frame acknowledged');
  mouse('mousedown', img);
  check(!sockets[0].sent.some(m => m.type === 'input_mouse'), 'no input while watching');
  button('Take over').click();
  await until(() => text().includes('You have control'), 'control tab');
  check(sockets.length === 1, 'same stream');
  mouse('mousedown', img); mouse('mouseup', img);
  const input = sockets[0].sent.filter(m => m.type === 'input_mouse').map(m => m.eventType + ' ' + m.x + ',' + m.y).join();
  check(input === 'mousePressed 20,15,mouseReleased 20,15', 'mouse input ' + input);
  button('Hand back').click();
  await until(() => !text().includes('You have control') && text().includes('Nobody'), 'control handed back');
  check(sent() === JSON.stringify([['/api/computers/sample/start', {}]]), 'requests ' + sent());
`, 'signedIn = true');

browserCase('handoff link: Take over focused, takes the request, Done sends the note', '#/handoff/h1', `
  await until(() => document.activeElement?.textContent === 'Take over', 'Take over focused');
  check(text().includes('An agent asked for help') && text().includes('Solve the captcha') && text().includes('An agent is waiting'), 'request banner');
  button('Take over').click();
  await until(() => text().includes('You have control') && button('Done'), 'request taken');
  button('Done').click();
  await until(dialog, 'note dialog');
  field('note', dialog()).value = 'Solved it'; dialog().requestSubmit();
  await until(() => text().includes('The agent can continue.'), 'handed back');
  check(sent() === JSON.stringify([['/api/computers/sample/handoff-take', {}], ['/api/computers/sample/start', {}],
    ['/api/computers/sample/handoff-done', { note: 'Solved it' }]]), 'requests ' + sent());
`, "signedIn = true; computers[0].handoff = { id: 'h1', state: 'pending', reason: 'Solve the captcha', created: new Date().toISOString(), deadline: new Date(Date.now() + 600000).toISOString() }");

browserCase('recording: a click in the view becomes a step, saved through the playbook editor', '#/profiles/sample', `
  (await until(() => button('Record playbook'), 'Record button')).click();
  await until(() => text().includes('each gesture becomes a step'), 'recording panel');
  frame(1);
  const img = await until(() => document.querySelector('#frame:not([hidden])'), 'frame');
  mouse('mousedown', img); mouse('mouseup', img);
  await until(() => document.querySelector('[aria-label=Recording] ol li')?.innerText.includes('Click OK'), 'step listed');
  check(!sockets[0].sent.some(m => m.type === 'input_mouse'), 'the click went to the gateway, not the stream');
  button('Save as playbook…').click();
  await until(() => document.activeElement === field('name'), 'playbook editor, name focused');
  check(document.querySelector('ol li [aria-label="Text on the page"]').value === 'OK', 'recorded step in the form');
  const click = writes.find(w => w[0].endsWith('/teach-click'))[1];
  check(click.x === 20 && click.y === 15 && click.seq === 1 && click.rec, 'teach-click ' + JSON.stringify(click));
`, 'signedIn = true');

browserCase('gateway admin reveals a new invite link once', '#/members', `
  const f = await until(() => field('email')?.form, 'invite form');
  field('email').value = 'new@example.test'; f.requestSubmit();
  await until(() => document.querySelector('[aria-label="Invite link"]')?.value.endsWith('#/invite/sample'), 'new link');
  button('Done').click();
  await until(() => !document.querySelector('[aria-label="Invite link"]'), 'link discarded');
  check(sent() === JSON.stringify([['/api/users/invite', { email: 'new@example.test', admin: false }]]), 'requests ' + sent());
`, 'signedIn = true');

browserCase('gateway admin confirms the private profile count before removing an active member', '#/members', `
  await until(() => text().includes('other@example.test'), 'member rows');
  const removes = [...document.querySelectorAll('tbody button')].filter(b => b.textContent === 'Remove');
  check(removes.length === 1, 'only other active members ' + removes.length);
  removes[0].click();
  await until(() => dialog()?.innerText.includes('Remove other@example.test?') && dialog().innerText.includes('2 private profiles'), 'deletion warning');
  check(writes.length === 0, 'requires confirmation');
  dialog().requestSubmit();
  await until(() => !text().includes('other@example.test'), 'removed');
  check(sent() === JSON.stringify([['/api/users/remove', { email: 'other@example.test' }]]), 'requests ' + sent());
`, "signedIn = true; stepUpLeft = 900; users.push(user('other@example.test', { privateProfileCount: 2 }), user('pending@example.test', { pending: true }))");

browserCase('a member without gateway admin is sent from Members to the profiles', '#/members', `
  await until(() => document.querySelector('h1')?.textContent === 'Profiles', 'profiles');
  check(!button('Members'), 'no Members navigation');
`, 'signedIn = true; gatewayAdmin = false');

browserCase('API key: scoped to a profile, shown once, closable only once saved', '#/access', `
  (await until(() => button('+ Create API key'), 'create button')).click();
  const f = await until(dialog, 'key dialog');
  field('name', f).value = 'ci-agent'; f.requestSubmit();
  const key = await until(() => document.querySelector('[aria-label="API key"]'), 'key shown');
  check(key.value === 'arb_k_secret-fixture', 'key value');
  check(text().includes('"url": "https://arb.example.test/mcp"'), 'MCP config');
  const close = button('Close');
  check(close.disabled, 'Close needs the saved box');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  check(document.querySelector('[aria-label="API key"]'), 'Escape keeps the key on screen');
  [...document.querySelectorAll('[role=dialog] input[type=checkbox]')][0].click();
  await until(() => !button('Close').disabled, 'Close enabled');
  button('Close').click();
  await until(() => !document.querySelector('[aria-label="API key"]'), 'key gone');
  await until(() => text().includes('Active access · 1') && text().includes('arb_k_ab…'), 'listed');
  check(sent() === JSON.stringify([['/api/keys', { name: 'ci-agent', scope: 'profile:sample', expiresIn: '90d' }]]), 'requests ' + sent());
`, 'signedIn = true; stepUpLeft = 900');

browserCase('security page shows the reset command for the signed-in account', '#/security', `
  await until(() => text().includes('Two-factor authentication is on'), 'security page');
  check(text().includes('docker compose exec gateway node src/cli.ts admin reset-2fa admin@example.test'), 'reset command');
`, 'signedIn = true');
