import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.ts';

const dev = { ALLOW_NO_SANDBOX: '1' };

test('defaults: loopback bind, POC ports, prefixed image', () => {
  const c = loadConfig(dev);
  assert.equal(c.bindAddr, '127.0.0.1');
  assert.deepEqual([c.port, c.adminPort, c.idleMs, c.prefix, c.image], [8787, 8788, 300_000, 'arb', 'arb-computer:dev']);
  assert.equal(loadConfig({ ...dev, ARB_PREFIX: 'x1', PORT: '', PUBLIC_URL: 'https://arb.example.com/' }).image, 'x1-computer:dev');
  assert.equal(loadConfig({ ...dev, PUBLIC_URL: 'https://arb.example.com/' }).publicUrl, 'https://arb.example.com');
});

test('sandbox runtime required unless explicitly waived', () => {
  assert.throws(() => loadConfig({}), /SANDBOX_RUNTIME=runsc is required/);
  assert.throws(() => loadConfig({ SANDBOX_RUNTIME: 'runc' }), /SANDBOX_RUNTIME=runsc is required/);
  assert.equal(loadConfig({ SANDBOX_RUNTIME: 'runsc' }).runtime, 'runsc');
});

test('production needs PUBLIC_URL and refuses quick tunnels', () => {
  const prod = { NODE_ENV: 'production', SANDBOX_RUNTIME: 'runsc' };
  assert.throws(() => loadConfig(prod), /PUBLIC_URL is required/);
  assert.throws(() => loadConfig({ ...prod, PUBLIC_URL: 'https://abc-def.trycloudflare.com' }), /Quick tunnels are refused/);
  assert.equal(loadConfig({ ...prod, PUBLIC_URL: 'https://arb.example.com' }).production, true);
});

test('invalid values fail fast with every problem listed', () => {
  const e = (() => { try { loadConfig({ ...dev, PORT: 'x', ARB_PREFIX: 'Bad_', BIND_ADDR: 'everywhere', PUBLIC_URL: 'ftp://x' }); } catch (e) { return String(e); } })();
  for (const k of ['PORT', 'ARB_PREFIX', 'BIND_ADDR', 'PUBLIC_URL']) assert.match(e!, new RegExp(`- ${k}:`));
  assert.throws(() => loadConfig({ ...dev, PORT: '9000', ADMIN_PORT: '9000' }), /must differ/);
});
