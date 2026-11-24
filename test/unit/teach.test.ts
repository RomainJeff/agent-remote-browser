import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, type AX } from '../../src/admin/teach.ts';
import { Locator } from '../../src/mcp/steps.ts';

const root: AX = { role: 'RootWebArea', name: 'Page' };

test('locate: a unique role + name, through generic wrappers and text nodes', () => {
  const chain: AX[] = [{ role: 'StaticText', name: 'Save' }, { role: 'button', name: 'Save', tag: 'button', count: 1, exact: 1 }, { role: 'generic', name: '', tag: 'div' }, root];
  assert.deepEqual(locate(chain), { locator: { role: 'button', name: 'Save' } });
  assert.deepEqual(locate([{ role: 'image', name: 'Logo', count: 1, exact: 1 }, root]), { locator: { role: 'img', name: 'Logo' } });
});

test('locate: duplicates fall back to an exact name, then css, else say how many match', () => {
  const link = (more: Partial<AX>): AX[] => [{ role: 'link', name: 'Docs', tag: 'a', count: 3, ...more }, root];
  assert.deepEqual(locate(link({ exact: 1 })), { locator: { role: 'link', name: 'Docs', exact: true } });
  assert.deepEqual(locate(link({ exact: 2, id: 'docs-2' })), { locator: { css: '#docs-2' } });
  assert.deepEqual(locate(link({ exact: 2, attr: 'docs' })), { locator: { css: 'a[name="docs"]' } });
  assert.deepEqual(locate(link({ exact: 2 })), { locator: { role: 'link', name: 'Docs', exact: true }, matches: 2 });
});

test('locate: unnamed fields by placeholder or css; nothing past a landmark', () => {
  assert.deepEqual(locate([{ role: 'textbox', name: '', tag: 'input', placeholder: 'Search', attr: 'q' }, root]), { locator: { placeholder: 'Search' } });
  assert.deepEqual(locate([{ role: 'textbox', name: '', tag: 'input', type: 'password', attr: 'pw' }, root]), { locator: { css: 'input[name="pw"]' } });
  assert.equal(locate([{ role: 'generic', name: '' }, { role: 'main', name: '' }, { role: 'button', name: 'Far', count: 1 }]), null);
  assert.equal(locate([root]), null);
  assert.equal(locate([]), null);
});

test('locate: names and ids that would not make a valid or safe locator are skipped', () => {
  // Leading dash (a flag), too long, odd id characters: on to the next candidate.
  assert.deepEqual(locate([{ role: 'button', name: '-x', count: 1, tag: 'button', id: 'ok' }, root]), { locator: { css: '#ok' } });
  assert.deepEqual(locate([{ role: 'button', name: 'x'.repeat(201), count: 1, tag: 'button', id: 'a"]b' }, { role: 'listitem', name: 'Row', count: 1 }, root]),
    { locator: { role: 'listitem', name: 'Row' } });
  for (const c of [[{ role: 'button', name: 'Save', count: 1 }], [{ role: 'textbox', name: '', tag: 'input', id: 'em' }], [{ role: 'link', name: 'Docs', count: 2, exact: 2 }]] as AX[][])
    assert.ok(Locator.safeParse(locate(c)!.locator).success);
});
