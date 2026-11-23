import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Steps, Step, stepArgv } from '../../src/mcp/steps.ts';

const parse = (s: unknown) => Step.parse(s);
const ok = (s: unknown) => Step.safeParse(s).success;

test('Steps: one key per step, unknown steps and extra keys refused, 1 to 20 steps', () => {
  for (const s of [{ open: 'https://example.com' }, { login: 'shop', if_needed: true }, { click: { ref: '@e1' } },
    { fill: { label: 'Email' }, value: 'me@x.test' }, { press: 'Enter' }, { back: true }, { wait: { ms: 500 } },
    { get_text: { contains: 'plan' }, keep: true }, { snapshot: {} }])
    assert.ok(ok(s), JSON.stringify(s));
  for (const s of [{ screenshot: true }, { request_human: { reason: 'x' } }, { eval: '1' }, { open: 'file:///etc/passwd' },
    { open: 'https://a.test', click: { ref: 'e1' } }, { click: { ref: 'e1' }, keep: true }, { click: { text: 'a', css: 'b' } },
    { click: { xpath: '//a' } }, { back: false }, { get_text: { selector: 'a', ref: '@e1' } }, { snapshot: { scope: '@e1' } },
    { get_text: { lease: 'x' } }, {}])
    assert.equal(ok(s), false, JSON.stringify(s));
  assert.ok(Steps.safeParse(Array(20).fill({ back: true })).success);
  assert.equal(Steps.safeParse(Array(21).fill({ back: true })).success, false);
  assert.equal(Steps.safeParse([]).success, false);
});

test('Steps: wait never takes --fn, a sleep is at most 5 s, a selector is not a number', () => {
  for (const w of [{ fn: 'window.done' }, { ms: 5001 }, { ms: 0 }, { ms: 1.5 }, { selector: '3000' }, { selector: '--fn' },
    { text: '--json' }, { load: 'idle' }, { ms: 100, text: 'x' }, {}])
    assert.equal(ok({ wait: w }), false, JSON.stringify(w));
});

test('Steps: locator values and fill values never read as flags; a dash value goes through a ref', () => {
  for (const s of [{ click: { text: '--json' } }, { click: { css: '-x' } }, { click: { role: 'Button' } }, { click: { role: 'a b' } },
    { fill: { label: 'Email' }, value: '--json' }, { fill: { label: 'Email' }, value: '' }, { click: { testid: 'a', exact: true } }])
    assert.equal(ok(s), false, JSON.stringify(s));
  assert.ok(ok({ fill: { ref: 'e2' }, value: '-dash' }));
  assert.ok(ok({ fill: { ref: 'e2' }, value: '' }));
});

test('stepArgv: each step to its agent-browser argv', () => {
  const cases: [unknown, string[] | null][] = [
    [{ open: 'https://example.com/a' }, ['open', 'https://example.com/a']],
    [{ login: 'shop' }, null],
    [{ click: { ref: 'e3' } }, ['click', '@e3']],
    [{ fill: { ref: '@e3' }, value: '-x' }, ['fill', '@e3', '--', '-x']],
    [{ click: { text: 'Sign in' } }, ['find', 'text', 'Sign in', 'click']],
    [{ click: { text: 'Sign in', exact: true } }, ['find', 'text', 'Sign in', 'click', '--exact']],
    [{ fill: { label: 'Email' }, value: 'me@x.test' }, ['find', 'label', 'Email', 'fill', 'me@x.test']],
    [{ fill: { placeholder: 'you@x', exact: true }, value: 'zz' }, ['find', 'placeholder', 'you@x', 'fill', 'zz', '--exact']],
    [{ click: { testid: 'go' } }, ['find', 'testid', 'go', 'click']],
    [{ click: { css: 'main h1' } }, ['find', 'first', 'main h1', 'click']],
    [{ click: { role: 'button' } }, ['find', 'role', 'button', 'click']],
    [{ click: { role: 'button', exact: true } }, ['find', 'role', 'button', 'click']],
    [{ click: { role: 'button', name: 'Go', exact: true } }, ['find', 'role', 'button', 'click', '--name', 'Go', '--exact']],
    [{ fill: { role: 'textbox', name: 'Email' }, value: 'a' }, ['find', 'role', 'textbox', 'fill', 'a', '--name', 'Email']],
    [{ press: 'Enter' }, ['press', 'Enter']],
    [{ back: true }, ['back']],
    [{ wait: { ms: 300 } }, ['wait', '300']],
    [{ wait: { selector: '#out' } }, ['wait', '#out']],
    [{ wait: { text: 'Welcome' } }, ['wait', '--text', 'Welcome']],
    [{ wait: { url: '**/dash' } }, ['wait', '--url', '**/dash']],
    [{ wait: { load: 'networkidle' } }, ['wait', '--load', 'networkidle']],
    [{ get_text: {} }, ['get', 'text', 'body']],
    [{ get_text: { ref: 'e4' } }, ['get', 'text', '@e4']],
    [{ get_text: { selector: '#usage' } }, ['get', 'text', '#usage']],
    [{ snapshot: {} }, ['snapshot', '-i', '-c']],
    [{ snapshot: { compact: false, scope: 'main' } }, ['snapshot', '-i', '-s', 'main']],
  ];
  for (const [s, argv] of cases) assert.deepEqual(stepArgv(parse(s)), argv, JSON.stringify(s));
});
