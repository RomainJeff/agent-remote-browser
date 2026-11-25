// The admin page's record draft (src/admin/ui/lib/record.ts), with the API stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSave, createRecorder, recBody } from '../../src/admin/ui/lib/record.ts';

function page() {
  const ctx: Record<string, any> = { toasts: [], calls: [], bodies: [], replies: {} };
  const R = createRecorder({
    toast(m) { ctx.toasts.push(m); },
    changed() {},
    async api(url, _m, body) {
      const a = url.split('teach-')[1]; ctx.calls.push(a); ctx.bodies.push(body); await new Promise((r) => setTimeout(r, 5));
      const r = ctx.replies[a]; if (r instanceof Error) throw r; return structuredClone(r);
    },
  });
  const T = { get rec() { return R.rec; }, withBuf: R.withBuf, addStep: R.addStep, addBuf: R.addBuf, tcall: R.tcall, recBody };
  const start = (id = 'p') => { R.start(id); return R.rec as any; };
  const click = () => R.click({ x: 1, y: 1 });
  return { ctx, T, start, click };
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const OK = { step: { click: { role: 'button', name: 'OK' } }, field: false };
const field = (name: string) => ({ step: { click: { role: 'textbox', name } }, field: true });
const fill = (name: string, v: string) => ({ step: { fill: { role: 'textbox', name }, value: v }, typed: v });
const LOGIN = { step: { login: 'main', if_needed: true } };

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

test('record: a login replaces the clicks and Tabs leading to it, nothing else (fills stay, username included)', () => {
  const { T, start } = page(), g = start();
  g.steps.push(fill('Tenant', 'fixture'), field('Username'));
  T.addStep(g, fill('Username', 'fixture')); // replaces the field click
  g.steps.push({ step: { press: 'Tab' } }, field('Password'));
  T.addStep(g, LOGIN);
  assert.deepEqual(g.steps.map((x: any) => x.step), [fill('Tenant', 'fixture').step, fill('Username', 'fixture').step, LOGIN.step]);
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
  assert.ok(ctx.bodies.every((b: any) => b.rec === g.rid), 'every call names its recording');
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
  assert.deepEqual([{ ...ctx.bodies.at(-1) }, g.steps[0].step.login], [{ login: 'b', rec: g.rid, after: undefined }, 'b']);
});

test('record: Save and Replay wait for a pending login pick instead of dropping it', async () => {
  const { ctx, T, start } = page(), g = start();
  g.steps.push(fill('Email', 'a')); g.pick = [{ site: 'a', username: 'x' }, { site: 'b', username: 'y' }];
  assert.equal(canSave(g), false);
  let saved = false;
  T.withBuf(async () => { saved = true; }, true); await settle();
  assert.deepEqual([saved, g.pick.length, ctx.toasts], [false, 2, ['Pick the saved login to use first, or Cancel']]);
  T.withBuf(async () => {}); await settle(); // a gesture in the view: the pick is dropped
  assert.equal(g.pick, null);
});

test('record: the first character asks the gateway to note the focused field; the flush follows it, a refusal drops the text', async () => {
  const { ctx, T, start, click } = page(), g = start();
  ctx.replies.click = OK; click(); await settle();
  ctx.replies.focus = {}; ctx.replies.type = fill('Email', 'ab');
  T.addBuf('a'); T.addBuf('b'); click(); await settle();
  assert.deepEqual(ctx.calls, ['click', 'focus', 'type', 'click']);
  assert.deepEqual([{ ...ctx.bodies[1] }, ctx.bodies[2].after], [{ rec: g.rid, after: 1 }, 1]);
  // The page moved the focus before the HIT noted it: the text is dropped, never sent.
  ctx.replies.focus = new Error('The focus is not on the field you clicked'); ctx.calls.length = 0;
  T.addBuf('hunter2'); click(); await settle();
  assert.deepEqual([ctx.calls, g.lost, g.buf], [['focus'], true, '']);
  T.addBuf('x'); assert.deepEqual([ctx.calls, g.buf], [['focus'], ''], 'typing is off until a click goes through');
});

test('record: a pick that comes back while a view click waits is dropped by that click', async () => {
  const { ctx, T, start, click } = page(), g = start();
  ctx.replies.type = { pick: [{ site: 'a', username: 'x' }, { site: 'b', username: 'y' }] }; ctx.replies.click = OK;
  g.buf = 'secret'; click(); click(); await settle();
  assert.deepEqual([ctx.calls, g.pick, g.steps.length], [['type', 'click'], null, 1]);
});

test('record: a replay that stops partway turns typing off, like a failed gesture', async () => {
  const { ctx, T, start } = page(), g = start();
  ctx.replies.replay = { ok: false, text: 'Step 2 failed' }; g.buf = 'hunter2';
  const r = await T.tcall(g, 'replay', { body: '' });
  assert.deepEqual([r.ok, g.lost, g.buf], [false, true, '']);
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
  assert.throws(() => T.recBody(g), /Input "email" is used for different values/);
  g.steps[2].pname = '__proto__';
  assert.throws(() => T.recBody(g), /Input name "__proto__"/);
});

test('record: Save and Replay are on as soon as there is a step or typing', () => {
  const { start } = page(), g = start();
  assert.equal(canSave(g), false);
  g.buf = 'x'; assert.equal(canSave(g), true);
});

test('record: Save and Replay take the draft after the typing buffer went through', async () => {
  const { ctx, T, start } = page(), g = start();
  ctx.replies.type = { step: { fill: { role: 'textbox', name: 'Email' }, value: 'me@x.test' } };
  g.buf = 'me@x.test'; let body = '';
  T.withBuf(async (g: any) => { body = T.recBody(g).body; }); await settle();
  assert.match(body, /me@x\.test/);
});
