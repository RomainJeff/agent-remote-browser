import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipe } from '../../src/mcp/steps.ts';
import { describe as describeBody } from '../../src/store/store.ts';

// The admin's playbook editor (pure part, between the pb-editor markers) must read a body the way the server does.
const html = readFileSync(new URL('../../src/admin/admin.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('// pb-editor:start'), html.indexOf('// pb-editor:end'));
const { pbParse, pbSerialize } = new Function(`${code}; return { pbParse, pbSerialize };`)();

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
  assert.ok(m.steps[3].raw, 'click with exact has no form field: kept as JSON');
  assert.equal(m.steps.filter((r: any) => r.raw).length, 1);
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
  assert.match(pbParse('# x\n```json\n{"steps": [\n```').err, /invalid JSON/);
  assert.match(pbParse('# x\n```json\n{"steps": [1]}\n```').err, /one object per step/);
});
