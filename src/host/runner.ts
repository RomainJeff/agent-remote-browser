// HostDriver for the gateway: every call is one request to the privileged runner over its Unix socket
// (src/runner/protocol.ts). The gateway holds no Docker socket; the runner decides what each request may do.
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { ProfileId } from '../policy.ts';
import type { Computer, ExecResult, HostDriver } from './driver.ts';
import { readLine, type Request } from '../runner/protocol.ts';

// ponytail: a reply is buffered whole; screenshots (base64 PNG) are the largest at a few MB.
const MAX_REPLY = 64 * 1024 ** 2;

export class RunnerDriver implements HostDriver {
  #path: string;
  constructor(path: string) { this.#path = path; }

  /** Sends one request; resolves with its result and the still open connection (the byte relay, for stream). */
  async #call(req: Request, ms: number) {
    const sock = net.connect(this.#path);
    // ponytail: client-side ceilings (exec: its own timeout + 15 s) in case the runner hangs; it enforces the real ones.
    sock.setTimeout(ms, () => sock.destroy(Error(`runner ${req.op}: no reply`)));
    sock.write(JSON.stringify(req) + '\n');
    try {
      const r = JSON.parse(await readLine(sock, MAX_REPLY));
      if (!r.ok) throw Error(String(r.error));
      sock.setTimeout(0);
      return { result: r.result, sock };
    } catch (e) { sock.destroy(); throw e; }
  }

  async #do(req: Request, ms = 60_000) {
    const { result, sock } = await this.#call(req, ms);
    sock.destroy();
    return result;
  }

  ensure(id: ProfileId, _opts: { egressDir: string }): Promise<Computer> { return this.#do({ op: 'ensure', id }); }
  exec(id: ProfileId, argv: string[], { stdin, timeoutMs }: { stdin?: string; timeoutMs: number }): Promise<ExecResult> {
    return this.#do({ op: 'exec', id, argv, ...(stdin != null && { stdin }), timeoutMs }, timeoutMs + 15_000);
  }
  async stream(id: ProfileId): Promise<Duplex> { return (await this.#call({ op: 'stream', id }, 60_000)).sock; }
  stop(id: ProfileId): Promise<void> { return this.#do({ op: 'stop', id }); }
  remove(id: ProfileId, { keepVolume }: { keepVolume: boolean }): Promise<void> { return this.#do({ op: 'remove', id, keepVolume }); }
  list(): Promise<Computer[]> { return this.#do({ op: 'list' }); }
}
