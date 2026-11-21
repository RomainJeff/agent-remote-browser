// Live view input filter: client→browser WebSocket frame parser. Synthetic frames only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frames } from '../../src/admin/routes.ts';

// A masked client frame.
function frame(text: string | Buffer, { op = 1, fin = true } = {}) {
  const data = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]), n = data.length;
  const head = n < 126 ? Buffer.from([0, 0x80 | n]) : Buffer.from([0, 0x80 | 126, n >> 8, n & 255]);
  head[0] = (fin ? 0x80 : 0) | op;
  return Buffer.concat([head, mask, data.map((b, i) => b ^ mask[i & 3])]);
}

test('frames: parses masked frames across chunk boundaries, 16-bit lengths, raw bytes intact', () => {
  const feed = frames();
  const ack = frame('{"type":"ack","seq":1}'), key = frame(JSON.stringify({ type: 'input_keyboard', text: 'x'.repeat(300) }));
  const all = Buffer.concat([ack, key]);
  assert.deepEqual(feed(all.subarray(0, 5)), []);
  const got = [...feed(all.subarray(5, 140))!, ...feed(all.subarray(140))!];
  assert.deepEqual(got.map((f) => JSON.parse(f.data.toString()).type), ['ack', 'input_keyboard']);
  assert.deepEqual(Buffer.concat(got.map((f) => f.raw)), all);
  assert.deepEqual(got.map((f) => [f.op, f.fin]), [[1, true], [1, true]]);
});

test('frames: fragments reported, unmasked or oversized frames refused', () => {
  assert.deepEqual(frames()(frame('a', { fin: false }))!.map((f) => [f.op, f.fin]), [[1, false]]);
  assert.equal(frames()(Buffer.from([0x81, 1, 0x61])), null, 'unmasked');
  assert.equal(frames(100)(frame('x'.repeat(200))), null, 'over max');
  assert.equal(frames()(Buffer.from([0x82, 0x80 | 127, 0, 0, 0, 1, 0, 0, 0, 0])), null, '64-bit length over 64 KiB');
});
