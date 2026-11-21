// Handoffs: lifecycle, one open per profile, lazy expiry/cancellation, retention, frozen lease. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { openStore } from '../../src/store/store.ts';
import { createLeases } from '../../src/mcp/leases.ts';
import { createHandoffs } from '../../src/mcp/handoffs.ts';
import { hash, parseProfileId } from '../../src/policy.ts';
import type { AuditEntry } from '../../src/audit.ts';

const scratch = mkdtempSync(join(tmpdir(), 'arb-handoffs-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function setup() {
  const db = openDb(join(scratch, `${++n}.db`)), store = openStore(db, join(scratch, `${n}.key`)), lines: AuditEntry[] = [];
  store.createProfile(parseProfileId('p')!, ['example.com']);
  const audit = Object.assign((e: AuditEntry) => { lines.push(e); }, { read: () => [] });
  return { db, leases: createLeases(db), h: createHandoffs(db, audit), lines };
}
const MIN = 60_000;

test('lifecycle: request -> take -> done; one open per profile; lease frozen then sliding again', () => {
  const { db, leases, h } = setup();
  const { token } = leases.take('p', 1), lh = hash(token);
  const r = h.request('p', lh, 'captcha', 30)!;
  assert.match(r.id, /^h_[\w-]{16}$/);
  assert.equal(r.state, 'pending');
  assert.equal(h.request('p', lh, 'again', 30), null);
  assert.ok(leases.of('p')!.exp >= r.deadline + MIN, 'frozen until the deadline');
  assert.ok(leases.use(token)!.exp >= r.deadline + MIN, 'use() does not shorten a frozen lease');
  assert.ok(leases.extend('p', 1)!.exp >= r.deadline + MIN, 'admin extend does not shorten a frozen lease');
  assert.equal(h.take(r.id)?.state, 'taken');
  assert.equal(h.take(r.id), null);
  assert.equal(h.open('p')?.state, 'taken');
  assert.equal(h.finish(r.id, 'done', 'ok')?.state, 'done');
  assert.equal(h.finish(r.id, 'failed', 'late'), null, 'ended once');
  assert.equal(h.open('p'), null);
  assert.ok(leases.of('p')!.exp <= Date.now() + MIN, 'lease slides from now again');
  assert.deepEqual({ ...h.last('p', lh) }, { ...db.prepare('SELECT * FROM handoffs').get() });
  assert.equal(h.last('p', null), null, 'another caller sees nothing');
  assert.ok(h.request('p', lh, 'next', 30), 'a new one once ended');
});

test('lazy transitions: deadline passed -> expired, lease gone -> cancelled; both audited', () => {
  const { db, leases, h, lines } = setup();
  const a = h.request('p', null, 'x', 1)!;
  db.prepare('UPDATE handoffs SET deadline = ? WHERE id = ?').run(Date.now() - 1, a.id);
  assert.equal(h.open('p'), null);
  assert.equal(h.last('p', null)?.state, 'expired');
  const { token } = leases.take('p', 1);
  h.request('p', hash(token), 'y', 30);
  leases.release(token);
  assert.equal(h.last('p', hash(token))?.state, 'cancelled');
  assert.deepEqual(lines.map((l) => l.tool), ['handoff:expired', 'handoff:cancelled']);
});

test('retention: ended handoffs older than 30 days go on the next request', () => {
  const { db, h } = setup();
  const a = h.request('p', null, 'old', 1)!;
  h.finish(a.id, 'failed', 'n');
  db.prepare('UPDATE handoffs SET ended = ? WHERE id = ?').run(Date.now() - 31 * 86_400_000, a.id);
  h.request('p', null, 'new', 1);
  assert.deepEqual(db.prepare('SELECT reason FROM handoffs').all().map((r: any) => r.reason), ['new']);
});
