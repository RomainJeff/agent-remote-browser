// Logs carry an error's code, never its message (URLs, page content).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errCode } from '../../src/audit.ts';

test('errCode: code only, never the message', () => {
  assert.equal(errCode(Error('net::ERR_PROXY_CONNECTION_FAILED at https://secret.test/?t=abc')), 'ERR_PROXY_CONNECTION_FAILED');
  assert.equal(errCode(Error("ENOENT: no such file, open '/x'")), 'ENOENT');
  assert.equal(errCode(Error('page.goto: Timeout 30000ms exceeded')), 'Timeout');
  assert.equal(errCode(Error('Chrome exited early on https://secret.test')), undefined);
  assert.equal(errCode('not an error'), undefined);
});
