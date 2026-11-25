import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipe } from '../../src/mcp/steps.ts';
import { describe as describeBody } from '../../src/store/store.ts';
import { describeStep, parse, partText, serialize, type Model } from '../../src/admin/ui/lib/playbook.ts';

// The admin's playbook editor must read a body the way the server does.
const pbParse = (body: string) => parse(body) as Model & { err?: string };
const pbSerialize = serialize;

const BODY = `# Check the executions quota of an n8n Cloud workspace

Fill {workspace} with the workspace name.

\`\`\`json
{
  "steps": [
    { "open": "https://app.n8n.cloud/manage" },
    { "wait": { "load": "networkidle" } },
    { "login": "n8n-cloud", "if_needed": true },
    { "click": { "text": "{workspace}", "exact": true } },
    { "fill": { "role": "textbox", "name": "Search" }, "value": "{q}" },
    { "wait": { "ms": 500 } },
    { "get_text": { "contains": "executions" }, "keep": true },
    { "snapshot": {} }
  ]
}
\`\`\`

If step 3 fails, call request_human.`;

test('playbook editor: parse then serialize keeps what the server reads (description, steps, placeholders, text)', () => {
  const m = pbParse(BODY);
  assert.equal(m.desc, describeBody(BODY));
  assert.equal(m.steps.length, 8);
  assert.ok('raw' in m.steps[3], 'click with exact has no form field: kept as JSON');
  assert.equal(m.steps.filter((r) => 'raw' in r).length, 1);
  const out = pbSerialize(m);
  assert.equal(describeBody(out), describeBody(BODY));
  assert.deepEqual(recipe(out, { workspace: 'w', q: 'x' }), recipe(BODY, { workspace: 'w', q: 'x' }));
  assert.match(out, /Fill \{workspace\} with the workspace name\.\n\n```json/);
  assert.ok(out.endsWith('If step 3 fails, call request_human.'));
  assert.equal(pbSerialize(pbParse(out)), out, 'stable once serialized');
});

test('playbook editor: no recipe, empty body, unreadable recipe', () => {
  assert.deepEqual(pbParse('# Just notes\n\nDo this, then that.'), { desc: 'Just notes', notes: 'Do this, then that.', steps: [], fallback: '' });
  assert.equal(pbSerialize(pbParse('')), '');
  assert.match(pbParse('# x\n```json\n{"steps": [\n```').err!, /invalid JSON/);
  assert.match(pbParse('# x\n```json\n{"steps": [1]}\n```').err!, /one object per step/);
});

test('playbook steps read as sentences, {inputs} kept apart, unknown shapes as JSON', () => {
  const steps = JSON.parse(BODY.split('```json')[1].split('```')[0]).steps;
  assert.deepEqual(steps.map((s: object) => partText(describeStep(s))), [
    'Open app.n8n.cloud/manage', 'Wait for the page to load', 'Sign in with the saved login n8n-cloud, if asked',
    'Click {workspace}', 'Type q in Search', 'Wait 500 ms', 'Read the text of the page around executions', 'List the elements',
  ]);
  assert.deepEqual(describeStep({ fill: { label: 'Email' }, value: '{email}' }), ['Type ', { input: 'email' }, ' in ', { el: 'Email' }]);
  assert.deepEqual(describeStep({ fill: { css: '#q' }, value: 'shoes' }), ['Type ', { val: 'shoes' }, ' in ', { code: '#q' }]);
  assert.equal(partText(describeStep({ get_text: { selector: '#total' } })), 'Read the text of #total');
  assert.equal(partText(describeStep({ teleport: true })), '{"teleport":true}');
});
