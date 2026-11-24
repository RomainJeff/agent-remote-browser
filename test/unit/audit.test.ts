// Logs carry an error's code, never its message (URLs, page content).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudit, errCode, log } from '../../src/audit.ts';

test('the acting email is persisted in the audit file and omitted from stdout logs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const audit = createAudit(join(dir, 'audit.jsonl'));
  const entry = { agent: 'shop', tool: 'admin:view', ok: true, by: 'operator@example.com', extra: 'discard' };
  audit(entry);
  const [{ ts, ...fields }] = audit.read();
  assert.deepEqual(fields, { agent: 'shop', tool: 'admin:view', ok: true, by: 'operator@example.com' });
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  log('info', 'view', entry);
  assert.equal(JSON.parse(stdout.mock.calls[0].arguments[0] as string).by, undefined);
});

test('errCode: code only, never the message', () => {
  assert.equal(errCode(Error('net::ERR_PROXY_CONNECTION_FAILED at https://secret.test/?t=abc')), 'ERR_PROXY_CONNECTION_FAILED');
  assert.equal(errCode(Error("ENOENT: no such file, open '/x'")), 'ENOENT');
  assert.equal(errCode(Error('page.goto: Timeout 30000ms exceeded')), 'Timeout');
  assert.equal(errCode(Error('Chrome exited early on https://secret.test')), undefined);
  assert.equal(errCode('not an error'), undefined);
});
