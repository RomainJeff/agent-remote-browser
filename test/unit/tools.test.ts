import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, grep } from '../../src/mcp/tools.ts';

const page = ['Header', 'Plan: Pro', 'Executions used: 120', 'of 2500', 'Footer', 'a', 'b', 'c', 'EXECUTIONS reset monthly', 'end'].join('\n');

test('grep: case-insensitive, context around each match, overlapping and touching windows merged, "…" between blocks', () => {
  assert.deepEqual(grep(page, 'executions', 1), { matches: 2, text: 'Plan: Pro\nExecutions used: 120\nof 2500\n…\nc\nEXECUTIONS reset monthly\nend' });
  // context 2: windows 0..4 and 6..9, line 5 ("a") between them stays out.
  assert.equal(grep(page, 'executions', 2).text, 'Header\nPlan: Pro\nExecutions used: 120\nof 2500\nFooter\n…\nb\nc\nEXECUTIONS reset monthly\nend');
  // context 3: windows 0..5 and 5..9 overlap: one block, every line once.
  assert.deepEqual(grep(page, 'executions', 3), { matches: 2, text: page });
  assert.deepEqual(grep('x\ny\nx', 'x', 0), { matches: 2, text: 'x\n…\nx' });
  assert.deepEqual(grep('x\nx\ny', 'x', 0), { matches: 2, text: 'x\nx' }, 'adjacent lines: one block');
});

test('grep: context 0 keeps the matching lines only; no match is not an error', () => {
  assert.deepEqual(grep(page, 'plan', 0), { matches: 1, text: 'Plan: Pro' });
  assert.deepEqual(grep(page, 'nowhere', 2), { matches: 0, text: '' });
  assert.deepEqual(grep('', 'x', 2), { matches: 0, text: '' });
});

test('clip: cuts at max and reports the total; untouched below it', () => {
  assert.deepEqual(clip('hello', 5), { text: 'hello' });
  assert.deepEqual(clip('hello', 2), { text: 'he', truncated: true, total_chars: 5 });
});
