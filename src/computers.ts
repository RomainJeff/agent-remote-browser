// The gateway's side of each computer: its egress proxy, its call queue, its idle timer, and agent-browser calls.
// Everything that touches the host goes through the HostDriver.
import { join } from 'node:path';
import type { HostDriver } from './host/driver.ts';
import type { ProfileId } from './policy.ts';
import type { Store } from './store/state.ts';
import { startProxy, type Proxy } from './egress/proxy.ts';
import { log } from './audit.ts';

// Chrome profile (IndexedDB, persistent cookies) + --restore state (session cookies, localStorage), both on the volume.
const PROFILE = '/home/agent/.agent-browser/profile';
const FLAGS = ['--json', '--profile', PROFILE, '--restore', 'agent',
  // --no-sandbox: the container is the sandbox (Chrome's own needs caps we dropped).
  '--args', '--no-sandbox,--proxy-server=http://127.0.0.1:3128,--proxy-bypass-list=<-loopback>,--disable-quic'];

export type Computers = ReturnType<typeof createComputers>;

export function createComputers(driver: HostDriver, store: Store, { egressDir, idleMs }: { egressDir: string; idleMs: number }) {
  const proxies = new Map<string, Proxy>();
  const queues = new Map<string, Promise<unknown>>();
  const lastUsed = new Map<string, number>(); // profile id -> ms
  const watching = new Map<string, number>(); // profile id -> open live views; the reaper leaves those alone

  /** One queue per profile: tool calls on one browser run in order, and no double create. */
  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, next);
    return next;
  }

  async function ensure(id: ProfileId) {
    if (!proxies.has(id)) proxies.set(id, await startProxy(join(egressDir, id), () => store.profile(id)?.allow || []));
    await driver.ensure(id, { egressDir });
    lastUsed.set(id, Date.now());
  }

  /** One agent-browser command on an already running computer, without touching its idle timer. Returns `data` or throws. */
  async function exec(id: ProfileId, args: string[], { stdin }: { stdin?: string } = {}): Promise<Record<string, any>> {
    const r = await driver.exec(id, ['agent-browser', ...FLAGS, ...args], { stdin, timeoutMs: 90_000 });
    if (r.code !== 0 && !r.stdout) throw Error((r.stderr || `exit ${r.code}`).slice(0, 500));
    const out = JSON.parse(r.stdout);
    if (out.error || out.success === false) throw Error(String(out.error));
    delete out.data?.lifecycle;
    return out.data ?? {};
  }

  /** Close Chrome cleanly (flushes profile + restore state), stop the container. Volume stays. */
  async function stop(id: ProfileId) {
    lastUsed.delete(id);
    await exec(id, ['close']).catch(() => {});
    await driver.stop(id).catch(() => {});
  }

  return {
    serial, ensure, exec, stop,
    /** Same as exec, starting the computer if needed. */
    ab: async (id: ProfileId, args: string[], opts?: { stdin?: string }) => { await ensure(id); return exec(id, args, opts); },

    async screenshot(id: ProfileId) {
      const { path } = await this.ab(id, ['screenshot']);
      const r = await driver.exec(id, ['base64', '-w0', String(path)], { timeoutMs: 30_000 });
      driver.exec(id, ['rm', '-f', String(path)], { timeoutMs: 10_000 }).catch(() => {});
      if (r.code !== 0) throw Error('screenshot read failed');
      return r.stdout;
    },

    /** Proxy policy for one computer: one origin only (during login), or the profile allowlist (no argument). */
    restrict: (id: string, origin?: string) => proxies.get(id)?.restrict(origin),

    async remove(id: ProfileId) {
      await driver.remove(id, { keepVolume: false });
      lastUsed.delete(id);
      proxies.get(id)?.close();
      proxies.delete(id);
    },

    idleStopInS: (id: string) => lastUsed.has(id) ? Math.max(0, Math.round((idleMs - (Date.now() - lastUsed.get(id)!)) / 1000)) : null,
    viewers: (id: string) => watching.get(id) || 0,
    /** A human opened the live view. Returns the function to call when they leave. */
    watch(id: string) {
      watching.set(id, (watching.get(id) || 0) + 1);
      return () => {
        watching.set(id, watching.get(id)! - 1);
        lastUsed.set(id, Date.now()); // idle countdown restarts when the human leaves
      };
    },

    reap() {
      for (const [id, t] of lastUsed) {
        if (watching.get(id) || Date.now() - t < idleMs) continue;
        lastUsed.delete(id);
        serial(id, () => stop(id as ProfileId).then(() => log('info', 'stopped idle computer', { profile: id })));
      }
    },

    closeProxies: () => { for (const p of proxies.values()) p.close(); },
  };
}
