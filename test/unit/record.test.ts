// The admin page's record draft (admin.html, between `let rec` and renderRec), run in a vm with the DOM and api stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../src/admin/admin.html', import.meta.url), 'utf8');
function page() {
  const ctx: Record<string, any> = {
    toasts: [], calls: [], replies: {}, $: () => null, setText() {}, renderRec() {}, plural: (n: number) => n,
    toast(m: string) { ctx.toasts.push(m); },
    async api(url: string) {
      const a = url.split('teach-')[1]; ctx.calls.push(a); await new Promise((r) => setTimeout(r, 5));
      const r = ctx.replies[a]; if (r instanceof Error) throw r; return structuredClone(r);
    },
  };
  vm.createContext(ctx);
  const src = html.slice(html.indexOf('let rec = null;'), html.indexOf('function renderRec()'));
  vm.runInContext(src + ';T = { get rec() { return rec }, set rec(v) { rec = v }, withBuf, addStep, recBody, tcall };', ctx);
  const T = ctx.T;
  const start = (id = 'p') => (T.rec = { id, steps: [] as any[], buf: '', q: Promise.resolve(), lost: false });
  const click = () => T.withBuf(async (g: any) => T.addStep(g, await T.tcall(g, 'click', { x: 1, y: 1 })));
  return { ctx, T, start, click };
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const OK = { step: { click: { role: 'button', name: 'OK' } }, field: false };
const field = (name: string) => ({ step: { click: { role: 'textbox', name } }, field: true });
const fill = (name: string, v: string) => ({ step: { fill: { role: 'textbox', name }, value: v }, typed: v });
const LOGIN = { step: { login: 'main', if_needed: true }, user: 'fixture' };

test('record: a failed click drops what was typed after it and turns typing off until a click goes through', async () => {
  const { ctx, start, click } = page(), g = start();
  ctx.replies.click = new Error('No stable locator');
  click(); g.buf = 'hunter2'; // typed while the click is in flight: meant for the field that was not focused
  await settle();
  assert.deepEqual([g.lost, g.buf, ctx.calls], [true, '', ['click']]);
  ctx.replies.click = OK; click(); await settle();
  assert.deepEqual([g.lost, g.steps.length], [false, 1]);
});

test('record: a gesture still running when the recording stops or another starts adds nothing', async () => {
  const { ctx, start, click } = page(), g = start('a');
  ctx.replies.click = OK; click();
  const g2 = start('b'); await settle();
  assert.deepEqual([g.steps.length, g2.steps.length, ctx.toasts], [0, 0, []]);
});

test('record: a login replaces its own username fill and the clicks and Tabs leading to it, nothing else', () => {
  const { T, start } = page();
  let g = start();
  g.steps.push(fill('Search', 'shoes'), field('Username'));
  T.addStep(g, fill('Username', 'fixture')); // replaces the field click
  g.steps.push({ step: { press: 'Tab' } }, field('Password'));
  T.addStep(g, LOGIN);
  assert.deepEqual(g.steps.map((x: any) => x.step), [fill('Search', 'shoes').step, LOGIN.step]);
  g = start(); g.steps.push(fill('Coupon', 'X1'), field('Password'));
  T.addStep(g, LOGIN);
  assert.deepEqual(g.steps.map((x: any) => x.step), [fill('Coupon', 'X1').step, LOGIN.step]);
});

test('record: Save and Replay take the draft after the typing buffer went through', async () => {
  const { ctx, T, start } = page(), g = start();
  ctx.replies.type = { step: { fill: { role: 'textbox', name: 'Email' }, value: 'me@x.test' } };
  g.buf = 'me@x.test'; let body = '';
  T.withBuf(async (g: any) => { body = T.recBody(g).body; }); await settle();
  assert.match(body, /me@x\.test/);
});
