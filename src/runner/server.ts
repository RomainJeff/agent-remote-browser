// The runner: the only process with the Docker socket. Serves protocol.ts on a Unix socket that only the gateway can
// reach (0600, on a volume mounted by these two services only), validates every request, then drives Docker.
// Run: node src/runner/server.ts        (config from env, see loadRunnerConfig)
//      node src/runner/server.ts check  (healthcheck: one `list` round trip through the socket and Docker)
import net from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { loadRunnerConfig } from '../config.ts';
import { log } from '../audit.ts';
import { DockerDriver } from '../host/docker.ts';
import { RunnerDriver } from '../host/runner.ts';
import type { HostDriver } from '../host/driver.ts';
import type { ProfileId } from '../policy.ts';
import { Request, MAX_REQUEST, pocVolume, readLine } from './protocol.ts';

export type Runner = HostDriver & { copyVolume(from: string, id: ProfileId): Promise<string> };

/** One request per connection. Invalid requests get a generic error: the reason stays in the runner.
 *  `migration`: accept copyVolume, which copies a POC profile (cookies included) into this stack.
 *  `maxComputers`: ensure refuses to start one more past this many running. */
export function serveRunner(driver: Runner, path: string, { migration = false, maxComputers = Infinity } = {}) {
  rmSync(path, { force: true }); // stale socket of a previous run
  // Ensures run one at a time, so two concurrent starts cannot both pass the cap.
  // ponytail: global queue, a slow start delays the others; per-id is enough if starts get slow.
  let ensuring: Promise<unknown> = Promise.resolve();
  const ensure = (id: ProfileId) => {
    const run = ensuring.then(async () => {
      const running = (await driver.list()).filter((c) => c.running);
      if (!running.some((c) => c.id === id) && running.length >= maxComputers) throw Error(`Too many computers running (MAX_COMPUTERS=${maxComputers})`);
      return driver.ensure(id, { egressDir: '' });
    });
    ensuring = run.catch(() => {});
    return run;
  };
  const server = net.createServer(async (sock) => {
    sock.on('error', () => {}); // the gateway hung up: nothing to do
    sock.setTimeout(10_000, () => sock.destroy()); // for the request line only
    let req: ReturnType<typeof Request.parse>;
    const t = Date.now(), reply = (r: object) => sock.end(JSON.stringify(r) + '\n');
    try {
      req = Request.parse(JSON.parse(await readLine(sock, MAX_REQUEST)));
    } catch {
      log('warn', 'runner refused a request', { ok: false });
      return sock.destroyed ? undefined : reply({ ok: false, error: 'invalid request' });
    }
    sock.setTimeout(0);
    const profile = 'id' in req ? req.id : undefined, done = (ok: boolean) => {
      if (req.op !== 'list' || !ok) log(ok ? 'info' : 'warn', 'runner', { tool: req.op, profile, ms: Date.now() - t, ok });
    };
    try {
      if (req.op === 'stream') {
        const d = await driver.stream(req.id);
        sock.write('{"ok":true}\n');
        sock.pipe(d).pipe(sock);
        d.on('error', () => sock.destroy()).on('close', () => sock.end());
        sock.on('close', () => d.destroy());
        return done(true);
      }
      const result = await (
        req.op === 'ensure' ? ensure(req.id)
        : req.op === 'exec' ? driver.exec(req.id, req.argv, { stdin: req.stdin, timeoutMs: req.timeoutMs })
        : req.op === 'stop' ? driver.stop(req.id)
        : req.op === 'remove' ? driver.remove(req.id, { keepVolume: req.keepVolume })
        : req.op === 'list' ? driver.list()
        : migration ? driver.copyVolume(pocVolume(req.id), req.id)
        : Promise.reject(Error('copyVolume disabled: set ALLOW_POC_MIGRATION=1 on the runner for the migration')));
      reply({ ok: true, result });
      done(true);
    } catch (e) {
      // Driver errors name the op and status (docker.ts keeps daemon text out), never arguments.
      reply({ ok: false, error: (e as Error).message });
      done(false);
    }
  });
  return new Promise<net.Server>((resolve, reject) => server.once('error', reject).listen(path, () => {
    chmodSync(path, 0o600);
    resolve(server);
  }));
}

if (import.meta.main) {
  let cfg: ReturnType<typeof loadRunnerConfig>;
  try { cfg = loadRunnerConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); }
  if (process.argv[2] === 'check') {
    process.exit(await new RunnerDriver(cfg.socket).list().then(() => 0, () => 1));
  }
  const server = await serveRunner(new DockerDriver({ socket: cfg.dockerSocket, prefix: cfg.prefix, image: cfg.image, runtime: cfg.runtime }), cfg.socket,
    { migration: cfg.migration, maxComputers: cfg.maxComputers });
  log(cfg.migration ? 'warn' : 'info', cfg.migration ? 'runner listening, copyVolume ENABLED (ALLOW_POC_MIGRATION)' : 'runner listening');
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => server.close(() => process.exit(0)));
}
