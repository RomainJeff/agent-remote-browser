import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, type AX } from '../../src/admin/teach.ts';
import { Locator } from '../../src/mcp/steps.ts';

const root: AX = { role: 'RootWebArea', name: 'Page' };

test('locate: a unique role + name, through generic wrappers and text nodes', () => {
  const chain: AX[] = [{ role: 'StaticText', name: 'Save' }, { role: 'button', name: 'Save', tag: 'button', count: 1, exact: 1 }, { role: 'generic', name: '', tag: 'div' }, root];
  assert.deepEqual(locate(chain), { role: 'button', name: 'Save' });
  assert.deepEqual(locate([{ role: 'image', name: 'Logo', count: 1, exact: 1 }, root]), { role: 'img', name: 'Logo' });
});

test('locate: duplicates fall back to an exact name, then a css matching one element, else nothing', () => {
  const link = (more: Partial<AX>): AX[] => [{ role: 'link', name: 'Docs', tag: 'a', count: 3, ...more }, root];
  assert.deepEqual(locate(link({ exact: 1 })), { role: 'link', name: 'Docs', exact: true });
  assert.deepEqual(locate(link({ exact: 2, id: 'docs-2', ids: 1 })), { css: '#docs-2' });
  assert.deepEqual(locate(link({ exact: 2, attr: 'docs', names: 1 })), { css: 'a[name="docs"]' });
  // Two "Delete" buttons named delete: every locator matches both, agent-browser would click the first.
  assert.equal(locate([{ role: 'button', name: 'Delete', tag: 'button', attr: 'delete', count: 2, exact: 2, names: 2 }, root]), null);
  // Duplicated id (invalid HTML, seen in the wild): not unique either.
  assert.equal(locate(link({ exact: 2, id: 'docs', ids: 2 })), null);
  assert.equal(locate(link({ exact: 2 })), null);
  // An ambiguous element does not walk up to a container that would match it: null, not the row.
  assert.equal(locate([{ role: 'button', name: 'Edit', count: 4, exact: 4 }, { role: 'listitem', name: 'Row', count: 1 }, root]), null);
});

test('locate: unnamed fields by placeholder or css, when unique; nothing past a landmark', () => {
  assert.deepEqual(locate([{ role: 'textbox', name: '', tag: 'input', placeholder: 'Search', ph: 1, attr: 'q', names: 1 }, root]), { placeholder: 'Search' });
  assert.deepEqual(locate([{ role: 'textbox', name: '', tag: 'input', placeholder: 'Search', ph: 2, attr: 'q', names: 1 }, root]), { css: 'input[name="q"]' });
  assert.equal(locate([{ role: 'textbox', name: '', tag: 'input', placeholder: 'Search', ph: 2 }, root]), null);
  assert.deepEqual(locate([{ role: 'textbox', name: '', tag: 'input', type: 'password', attr: 'pw', names: 1 }, root]), { css: 'input[name="pw"]' });
  assert.equal(locate([{ role: 'generic', name: '' }, { role: 'main', name: '' }, { role: 'button', name: 'Far', count: 1 }]), null);
  assert.equal(locate([root]), null);
  assert.equal(locate([]), null);
});

test('locate: names and ids that would not make a valid or safe locator are skipped', () => {
  // Leading dash (a flag), too long, odd id characters: on to the next candidate.
  assert.deepEqual(locate([{ role: 'button', name: '-x', count: 1, tag: 'button', id: 'ok', ids: 1 }, root]), { css: '#ok' });
  assert.deepEqual(locate([{ role: 'button', name: 'x'.repeat(201), count: 1, tag: 'button', id: 'a"]b', ids: 1 }, { role: 'listitem', name: 'Row', count: 1 }, root]),
    { role: 'listitem', name: 'Row' });
  for (const c of [[{ role: 'button', name: 'Save', count: 1 }], [{ role: 'textbox', name: '', tag: 'input', id: 'em', ids: 1 }], [{ role: 'link', name: 'Docs', count: 2, exact: 1 }]] as AX[][])
    assert.ok(Locator.safeParse(locate(c)).success);
});
