// Exercise the shipped page in a real DOM. All API replies are local fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const page = readFileSync(new URL('../../src/admin/admin.html', import.meta.url), 'utf8');
const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));

const fixture = `
const writes = [], email = 'member@example.com';
const users = [];
let gatewayAdmin = true, role = 'admin', members = [{ email, role: 'admin' }];
window.fetch = async (path, options = {}) => {
  const body = options.body && JSON.parse(options.body);
  if (body) writes.push([path, body]);
  const json = (value, status = 200) => ({ status, ok: status < 400, json: async () => value });
  switch (path) {
    case '/api/invite/start': return json({totpURI: 'otpauth://fixture'});
    case '/api/invite/finish': return body.code === '123456' ? json({backupCodes:['sample-backup']}) : json({error:'Invalid code'}, 401);
    case '/api/auth/get-session': return json({user:{twoFactorEnabled:true}});
    case '/api/session': return json({ email, stepUpRemainingS: 60 });
    case '/api/users': return gatewayAdmin ? json(users) : json({error:'forbidden'}, 403);
    case '/api/users/remove': return json({removed:true});
    case '/api/users/invites': return json([]);
    case '/api/users/invite': return json({link:'https://example.com/#/invite/sample'});
    case '/api/clients': return json({keys:[], oauth:[]});
    case '/api/computers': return json([{id:'sample', role, members:1, allow:[], logins:[], state:'running'}]);
    case '/api/computers/sample': return json({logins:[], headers:[], playbooks:[], audit:[], cookies:[], storage:[]});
    case '/api/computers/sample/members': return json(body || members);
    case '/api/computers/sample/candidates': return json(['new@example.com', 'third@example.com']);
    default: throw Error(path);
  }
};`;

function browserCase(name: string, hash: string, setup: string, scenario: string) {
  test(name, { skip: !chrome && 'Chrome or Chromium required' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'arb-dom-'));
    try {
      const path = join(dir, 'page.html');
      const script = `<script>
        const check = (ok, message) => { if (!ok) throw Error(message); };
        const settle = () => new Promise(resolve => setTimeout(resolve, 10));
        const visible = el => !!el?.getClientRects().length;
        addEventListener('load', async () => {
          try { await settle(); ${scenario}; document.body.textContent = 'PASS'; }
          catch(e) { document.body.textContent = 'FAIL ' + e.message; }
        });
      </script>`;
      writeFileSync(path, page.replace('<script>', () => '<script>' + fixture + setup + '</script><script>').replace('</body>', () => script + '</body>'));
      const result = spawnSync(chrome!, ['--headless', '--disable-gpu', '--disable-background-networking',
        '--user-data-dir=' + join(dir, 'browser'), '--dump-dom', '--virtual-time-budget=2000', pathToFileURL(path).href + hash],
      { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.equal(result.stdout.match(/<body>([^<]*)<\/body>/)?.[1], 'PASS');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

browserCase('invite enrollment keeps an invalid code on screen, then shows backup codes once', '#/invite/sample', '', `
  const enrollment = () => document.querySelector('#enroll form');
  enrollment().password.value = 'test-password';
  enrollment().requestSubmit(); await settle();
  check(enrollment().querySelector('textarea').value === 'otpauth://fixture', 'authenticator URI');
  check(document.querySelector('#enroll [aria-current=step]').textContent.endsWith('Authenticator'), 'current step');
  enrollment().code.value = '000000'; enrollment().requestSubmit(); await settle();
  check(enrollment().innerText.includes('Invalid code'), 'API error');
  enrollment().code.value = '123456'; enrollment().requestSubmit(); await settle();
  check(document.body.innerText.includes('sample-backup'), 'backup code');
  document.querySelector('#enroll a').click(); await settle();
  check(!document.querySelector('#enroll').textContent.includes('sample-backup') && visible(document.querySelector('#pwForm')), 'sign-in');
  check(JSON.stringify(writes) === JSON.stringify([
    ['/api/invite/start',{token:'sample', password:'test-password'}],
    ['/api/invite/finish',{token:'sample', code:'000000'}], ['/api/invite/finish',{token:'sample', code:'123456'}]
  ]), 'invite requests');
`);

browserCase('gateway admin sees Members and can reveal a new invite link once', '#/members', '', `
  check(visible(document.querySelector('[data-nav=members]')), 'members navigation');
  const f = document.querySelector('#inviteMember');
  f.email.value = email; f.requestSubmit(); await settle();
  check(document.querySelector('dialog[open] input').value.endsWith('#/invite/sample'), 'new link');
  document.querySelector('#closeInvite').click(); await settle();
  check(!document.querySelector('#keyDlg input'), 'link discarded');
`);

browserCase('viewer sees Watch without takeover or Members navigation', '#/p/sample', "gatewayAdmin=false; role='viewer';", `
  check(visible(document.querySelector('#bWatch')), 'watch');
  check(!visible(document.querySelector('#bCtl')), 'takeover');
  check(!visible(document.querySelector('[data-nav=members]')), 'members navigation');
`);

browserCase('editor opening settings sees the session without Delete', '#/p/sample/settings', "role='editor';", `
  check(visible(document.querySelector('#bCtl')), 'takeover');
  check(!visible(document.querySelector('#bDelete')), 'delete');
`);

browserCase('profile admin picks members to add, then changes and removes sharing', '#/p/sample/sharing', "members.push({ email: 'other@example.com', role: 'editor' });", `
  const f = document.querySelector('#shareForm'), pick = f.querySelector('details');
  f.requestSubmit(); await settle();
  check(pick.open && writes.length === 0, 'empty pick opens the list');
  for (const box of f.querySelectorAll('[name=email]')) box.click();
  check(f.querySelector('summary').textContent === '2 selected', 'selection count');
  f.elements.role.value = 'viewer'; f.requestSubmit(); await settle();
  check(!pick.open, 'list closed after adding');
  const select = document.querySelector('[data-member]');
  select.value = 'editor'; select.dispatchEvent(new Event('change')); await settle();
  check(!document.querySelector('[data-remove="' + email + '"]'), 'no Remove on own row');
  document.querySelector('[data-remove]').click(); await settle();
  check(JSON.stringify(writes) === JSON.stringify([
    {email:'new@example.com', role:'viewer'}, {email:'third@example.com', role:'viewer'}, {email, role:'editor'}, {email:'other@example.com', role:null}
  ].map(body => ['/api/computers/sample/members', body])), 'membership requests ' + JSON.stringify(writes));
`);

browserCase('gateway admin confirms the private profile count before removing an active member', '#/members',
  "users.push({email}, {email:'other@example.com',privateProfileCount:2}, {email:'pending@example.com',pending:true});", `
  const buttons = document.querySelectorAll('[data-remove-user]');
  check(buttons.length === 1, 'only other active members');
  buttons[0].click(); await settle();
  const dialog = document.querySelector('dialog[open]');
  check(dialog.innerText.includes('other@example.com') && dialog.innerText.includes('2 private profiles'), 'deletion warning');
  check(writes.length === 0, 'requires confirmation');
  dialog.querySelector('button[type=submit]').click(); await settle();
  check(JSON.stringify(writes) === JSON.stringify([['/api/users/remove',{email:'other@example.com'}]]), 'confirmed removal');
`);
