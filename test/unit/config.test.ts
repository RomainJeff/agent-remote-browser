import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadRunnerConfig } from '../../src/config.ts';

const dev = { ALLOW_NO_SANDBOX: '1' };

test('defaults: loopback bind, ports 8787/8788, runner socket; runner: prefixed image', () => {
  const c = loadConfig(dev);
  assert.equal(c.bindAddr, '127.0.0.1');
  assert.deepEqual([c.port, c.adminPort, c.idleMs, c.prefix, c.runnerSocket], [8787, 8788, 300_000, 'arb', '/run/arb-runner/runner.sock']);
  assert.equal(loadConfig({ ...dev, PUBLIC_URL: 'https://arb.example.com/' }).publicUrl, 'https://arb.example.com');
  const r = loadRunnerConfig(dev);
  assert.deepEqual([r.prefix, r.image, r.dockerSocket, r.socket], ['arb', 'arb-computer:dev', '/var/run/docker.sock', '/run/arb-runner/runner.sock']);
  assert.deepEqual([r.maxComputers, loadRunnerConfig({ ...dev, MAX_COMPUTERS: '10' }).maxComputers], [4, 10]);
  assert.throws(() => loadRunnerConfig({ ...dev, MAX_COMPUTERS: '0' }), /- MAX_COMPUTERS:/);
  assert.equal(c.trustProxy, false);
  assert.equal(loadConfig({ ...dev, TRUST_PROXY: 'cloudflare' }).trustProxy, true);
  assert.throws(() => loadConfig({ ...dev, TRUST_PROXY: 'yes' }), /- TRUST_PROXY:/);
  assert.equal(loadRunnerConfig({ ...dev, ARB_PREFIX: 'x1', IMAGE: '' }).image, 'x1-computer:dev');
  assert.throws(() => loadRunnerConfig({ ...dev, ARB_PREFIX: 'Bad_' }), /- ARB_PREFIX:/);
});

test('runner: sandbox runtime required unless explicitly waived', () => {
  assert.throws(() => loadRunnerConfig({}), /SANDBOX_RUNTIME=runsc is required/);
  assert.throws(() => loadRunnerConfig({ SANDBOX_RUNTIME: 'runc' }), /SANDBOX_RUNTIME=runsc is required/);
  assert.equal(loadRunnerConfig({ SANDBOX_RUNTIME: 'runsc' }).runtime, 'runsc');
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

test('auth: Cloudflare Access needs both values, a public admin needs PUBLIC_URL, secret 32+ characters', () => {
  const aud = 'a'.repeat(64);
  assert.throws(() => loadConfig({ ...dev, ACCESS_AUD: aud }), /both ACCESS_AUD and ACCESS_TEAM/);
  assert.throws(() => loadConfig({ ...dev, ACCESS_AUD: 'short', ACCESS_TEAM: 'team' }), /ACCESS_AUD/);
  assert.deepEqual(loadConfig({ ...dev, ACCESS_AUD: aud, ACCESS_TEAM: 'team' }).access, { aud, team: 'team' });
  assert.equal(loadConfig(dev).access, null);
  assert.equal(loadConfig(dev).adminPublic, false);
  assert.throws(() => loadConfig({ ...dev, ADMIN_PUBLIC: '1' }), /ADMIN_PUBLIC=1 requires PUBLIC_URL/);
  // The admin never goes public without Cloudflare Access in front.
  assert.throws(() => loadConfig({ ...dev, ADMIN_PUBLIC: '1', PUBLIC_URL: 'https://arb.example.com' }), /ADMIN_PUBLIC=1 requires Cloudflare Access/);
  assert.equal(loadConfig({ ...dev, ADMIN_PUBLIC: '1', PUBLIC_URL: 'https://arb.example.com', ACCESS_AUD: aud, ACCESS_TEAM: 'team' }).adminPublic, true);
  assert.throws(() => loadConfig({ ...dev, BETTER_AUTH_SECRET: 'x'.repeat(31) }), /BETTER_AUTH_SECRET/);
});
