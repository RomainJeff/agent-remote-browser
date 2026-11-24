// The admin page's record draft (admin.html, between `let rec` and renderRec), run in a vm with the DOM and api stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../src/admin/admin.html', import.meta.url), 'utf8');
function page() {
  const ctx: Record<string, any> = {
    toasts: [], calls: [], bodies: [], replies: {}, els: {}, $: (s: string) => ctx.els[s] ?? null, setText() {}, renderRec() {}, plural: (n: number) => n,
    toast(m: string) { ctx.toasts.push(m); },
    async api(url: string, _m: string, body: unknown) {
      const a = url.split('teach-')[1]; ctx.calls.push(a); ctx.bodies.push(body); await new Promise((r) => setTimeout(r, 5));
      const r = ctx.replies[a]; if (r instanceof Error) throw r; return structuredClone(r);
    },
  };
  vm.createContext(ctx);
  const src = html.slice(html.indexOf('let rec = null;'), html.indexOf('function renderRec()'));
  vm.runInContext(src + ';T = { get rec() { return rec }, set rec(v) { rec = v }, withBuf, addStep, recBody, tcall, renderBuf };', ctx);
  const T = ctx.T;
  const start = (id = 'p') => (T.rec = { id, steps: [] as any[], buf: '', q: Promise.resolve(), lost: false } as any);
  const click = () => T.withBuf(async (g: any) => T.addStep(g, await T.tcall(g, 'click', { x: 1, y: 1 })));
  return { ctx, T, start, click };
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const OK = { step: { click: { role: 'button', name: 'OK' } }, field: false };
const field = (name: string) => ({ step: { click: { role: 'textbox', name } }, field: true });
const fill = (name: string, v: string) => ({ step: { fill: { role: 'textbox', name }, value: v }, typed: v });
const LOGIN = { step: { login: 'main', if_needed: true }, user: 'fixture', form: 7 };

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
  T.addStep(g, { ...fill('Username', 'fixture'), form: 7 }); // replaces the field click
  g.steps.push({ step: { press: 'Tab' } }, field('Password'));
  T.addStep(g, LOGIN);
  assert.deepEqual(g.steps.map((x: any) => x.step), [fill('Search', 'shoes').step, LOGIN.step]);
  g = start(); g.steps.push(fill('Coupon', 'X1'), field('Password'));
  T.addStep(g, LOGIN);
  assert.deepEqual(g.steps.map((x: any) => x.step), [fill('Coupon', 'X1').step, LOGIN.step]);
  // The same text in another form's field, or in no form (identity unknown): kept.
  for (const form of [3, undefined]) {
    g = start(); g.steps.push({ ...fill('Search', 'fixture'), form });
    T.addStep(g, LOGIN);
    assert.deepEqual(g.steps.map((x: any) => x.step), [fill('Search', 'fixture').step, LOGIN.step]);
  }
});

test('record: typing names the gesture it follows; text queued behind a gesture that fails is dropped, never sent', async () => {
  const { ctx, T, start, click } = page(), g = start();
  ctx.replies.click = OK; click(); await settle();
  ctx.replies.press = new Error('Leased by an agent');
  g.buf = 'a'; T.withBuf(async (g: any) => T.addStep(g, await T.tcall(g, 'press', { key: 'Tab' })));
  g.buf = 'hunter2'; T.withBuf(async () => {}); // typed for the field the Tab was meant to reach
  ctx.replies.type = fill('Email', 'a'); await settle();
  assert.deepEqual(ctx.calls, ['click', 'type', 'press']);
  assert.deepEqual([ctx.bodies[0].seq, ctx.bodies[1].after, ctx.bodies[2].seq], [1, 1, 2]);
  assert.deepEqual([g.lost, ctx.toasts.length], [true, 2]);
  assert.ok(!JSON.stringify(ctx.bodies).includes('hunter2'));
});

test('record: several saved logins come back as a pick, the rest of that gesture is dropped', async () => {
  const { ctx, T, start, click } = page(), g = start();
  ctx.replies.type = { pick: [{ site: 'a', username: 'x' }, { site: 'b', username: 'y' }] };
  ctx.replies.click = OK; g.buf = 'secret'; click(); await settle();
  assert.deepEqual([ctx.calls, g.pick.map((l: any) => l.site), g.steps.length], [['type'], ['a', 'b'], 0]);
  ctx.replies.type = { ...LOGIN, step: { login: 'b', if_needed: true } };
  await T.tcall(g, 'type', { login: 'b' }).then((r: any) => T.addStep(g, r));
  assert.deepEqual([{ ...ctx.bodies.at(-1) }, g.steps[0].step.login], [{ login: 'b', after: undefined }, 'b']);
});

test('record: distinct default param names; one name for two different values is refused', () => {
  const { T, start } = page(), g = start();
  T.addStep(g, fill('Email', 'a')); T.addStep(g, OK); T.addStep(g, fill('Email', 'b')); T.addStep(g, OK); T.addStep(g, fill('Email', 'a'));
  assert.deepEqual(g.steps.filter((x: any) => x.pname).map((x: any) => x.pname), ['email', 'email_2', 'email_3']);
  for (const x of g.steps) x.param = true;
  assert.deepEqual({ ...T.recBody(g).params }, { email: 'a', email_2: 'b', email_3: 'a' });
  g.steps[4].pname = 'email';
  assert.deepEqual({ ...T.recBody(g).params }, { email: 'a', email_2: 'b' }, 'same name, same value: one param');
  g.steps[2].pname = 'email';
  assert.throws(() => T.recBody(g), /Param "email" is used for different values/);
});

test('record: Save and Replay are on as soon as there is a step or typing', () => {
  const { ctx, T, start } = page(), g = start();
  ctx.els = { '#bRecReplay': {}, '#bRecSave': {} };
  T.renderBuf(); assert.deepEqual([ctx.els['#bRecReplay'].disabled, ctx.els['#bRecSave'].disabled], [true, true]);
  g.buf = 'x'; T.renderBuf(); assert.deepEqual([ctx.els['#bRecReplay'].disabled, ctx.els['#bRecSave'].disabled], [false, false]);
});

test('record: Save and Replay take the draft after the typing buffer went through', async () => {
  const { ctx, T, start } = page(), g = start();
  ctx.replies.type = { step: { fill: { role: 'textbox', name: 'Email' }, value: 'me@x.test' } };
  g.buf = 'me@x.test'; let body = '';
  T.withBuf(async (g: any) => { body = T.recBody(g).body; }); await settle();
  assert.match(body, /me@x\.test/);
});
