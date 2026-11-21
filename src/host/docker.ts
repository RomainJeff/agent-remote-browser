// HostDriver on the Docker Engine HTTP API, over the Unix socket. No docker CLI, no dependency.
import http from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import type { ProfileId } from '../policy.ts';
import { bridge } from '../egress/bridge.ts';
import { relay, type Computer, type ExecResult, type HostDriver } from './driver.ts';

const API = '/v1.47'; // pinned: Docker Engine 27+. VolumeOptions.Subpath needs >= 1.45.

export interface DockerOptions { socket: string; prefix: string; image: string; runtime?: string }

interface Reply { status: number; body: any }

/** Engine API stdout/stderr multiplexing: 8-byte header [stream, 0, 0, 0, size uint32 BE], then the payload. */
export function demux(onFrame: (stream: number, payload: Buffer) => void) {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8 && buf.length >= 8 + buf.readUInt32BE(4)) {
      const end = 8 + buf.readUInt32BE(4);
      onFrame(buf[0], buf.subarray(8, end));
      buf = buf.subarray(end);
    }
  };
}

export class DockerDriver implements HostDriver {
  #o: DockerOptions;
  constructor(o: DockerOptions) { this.#o = o; }

  #name = (id: ProfileId) => `${this.#o.prefix}-${id}`;
  #volume = (id: ProfileId) => `${this.#o.prefix}-profile-${id}`;
  get #label() { return `${this.#o.prefix}-computer`; }

  #request(method: string, path: string, body?: object, ok = [200, 201, 204]): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.#o.socket, method, path: API + path,
        headers: { 'content-type': 'application/json' } }, (res) => {
        let raw = '';
        res.setEncoding('utf8').on('data', (d) => { raw += d; }).on('end', () => {
          const status = res.statusCode!;
          let parsed: any = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch {}
          // Error text from the daemon can quote names and paths: keep it out of what callers may log.
          if (!ok.includes(status)) reject(Error(`Docker API ${method} ${path.split('?')[0]}: ${status}`));
          else resolve({ status, body: parsed });
        });
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  /** The only container spec this gateway ever creates. Callers choose the profile, nothing else. */
  #spec(id: ProfileId) {
    const { prefix, image, runtime } = this.#o;
    return {
      Image: image,
      Cmd: ['node', '-e', bridge],
      Labels: { [this.#label]: id },
      HostConfig: {
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: 512,
        Memory: 1024 ** 3,
        NanoCpus: 1e9,
        ShmSize: 512 * 1024 ** 2,
        ...(runtime && { Runtime: runtime }),
        Mounts: [
          // ponytail: volume is plaintext on the host disk. Upgrade: encrypted volume / state save+KMS.
          { Type: 'volume', Source: this.#volume(id), Target: '/home/agent/.agent-browser' },
          { Type: 'volume', Source: `${prefix}-egress`, Target: '/egress', ReadOnly: true, VolumeOptions: { Subpath: id } },
        ],
      },
    };
  }

  async #inspect(id: ProfileId) {
    const r = await this.#request('GET', `/containers/${this.#name(id)}/json`, undefined, [200, 404]);
    return r.status === 404 ? null : r.body as { State: { Running: boolean; StartedAt: string }; HostConfig: { NetworkMode: string } };
  }

  // ponytail: egressDir is where the gateway sees the proxy socket; Docker reaches it through the
  // ${prefix}-egress volume (Subpath = id), so only drivers that bind host paths need it.
  async ensure(id: ProfileId, _opts: { egressDir: string }): Promise<Computer> {
    const name = this.#name(id);
    let c = await this.#inspect(id);
    if (c && c.HostConfig.NetworkMode !== 'none') { // Spec from an older gateway: recreate, keep the profile volume.
      await this.remove(id, { keepVolume: true });
      c = null;
    }
    if (!c) {
      await this.#request('POST', '/volumes/create', { Name: this.#volume(id), Labels: { [this.#label]: id } });
      await this.#request('POST', `/containers/create?name=${name}`, this.#spec(id));
    }
    if (!c?.State.Running) await this.#request('POST', `/containers/${name}/start`, undefined, [204, 304]);
    const now = c?.State.Running ? c : await this.#inspect(id);
    return { id, running: true, startedAt: now ? Date.parse(now.State.StartedAt) : undefined };
  }

  /** exec create + start, hijacked: returns the raw connection (stdin out, multiplexed stdout/stderr in). */
  async #attach(id: ProfileId, argv: string[], stdin: boolean) {
    const { body } = await this.#request('POST', `/containers/${this.#name(id)}/exec`,
      { Cmd: argv, AttachStdin: stdin, AttachStdout: true, AttachStderr: true, Tty: false });
    const execId: string = body.Id;
    const sock = await new Promise<Socket>((resolve, reject) => {
      const req = http.request({ socketPath: this.#o.socket, method: 'POST', path: `${API}/exec/${execId}/start`,
        headers: { 'content-type': 'application/json', connection: 'Upgrade', upgrade: 'tcp' } });
      req.on('upgrade', (_res, s, head) => { if (head.length) s.unshift(head); resolve(s); });
      req.on('response', (res) => { res.resume(); reject(Error(`Docker API exec start: ${res.statusCode}`)); });
      req.on('error', reject);
      req.end(JSON.stringify({ Detach: false, Tty: false }));
    });
    return { execId, sock };
  }

  async exec(id: ProfileId, argv: string[], { stdin, timeoutMs }: { stdin?: string; timeoutMs: number }): Promise<ExecResult> {
    const { execId, sock } = await this.#attach(id, argv, stdin != null);
    const out: Buffer[][] = [[], [], []];
    await new Promise<void>((resolve, reject) => {
      // ponytail: the Engine API cannot kill an exec; on timeout the process may run on inside the computer.
      const timer = setTimeout(() => { sock.destroy(); reject(Error('exec timed out')); }, timeoutMs);
      sock.on('data', demux((s, p) => out[s]?.push(p)));
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
      sock.on('close', () => { clearTimeout(timer); resolve(); });
      if (stdin != null) sock.end(stdin); // half-close = EOF on the process stdin
    });
    let { body } = await this.#request('GET', `/exec/${execId}/json`);
    for (let i = 0; body.Running && i < 20; i++) { // the stream can close a moment before the exit code is recorded
      await new Promise((r) => setTimeout(r, 50));
      ({ body } = await this.#request('GET', `/exec/${execId}/json`));
    }
    return { code: body.ExitCode ?? -1, stdout: Buffer.concat(out[1]).toString('utf8'), stderr: Buffer.concat(out[2]).toString('utf8') };
  }

  async stream(id: ProfileId): Promise<Duplex> {
    const { sock } = await this.#attach(id, ['node', '-e', relay], true);
    const d = new Duplex({
      read() {},
      write(chunk, _enc, cb) { sock.write(chunk, cb); },
      final(cb) { sock.end(); cb(); },
      destroy(err, cb) { sock.destroy(); cb(err); },
    });
    sock.on('data', demux((s, p) => { if (s === 1) d.push(p); }));
    sock.on('end', () => d.push(null));
    sock.on('close', () => d.destroy());
    sock.on('error', (e) => d.destroy(e));
    return d;
  }

  async stop(id: ProfileId) {
    await this.#request('POST', `/containers/${this.#name(id)}/stop?t=2`, undefined, [204, 304, 404]);
  }

  async remove(id: ProfileId, { keepVolume }: { keepVolume: boolean }) {
    await this.#request('DELETE', `/containers/${this.#name(id)}?force=true`, undefined, [204, 404]);
    if (!keepVolume) await this.#request('DELETE', `/volumes/${this.#volume(id)}?force=true`, undefined, [204, 404]);
  }

  async list(): Promise<Computer[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [this.#label] }));
    const { body } = await this.#request('GET', `/containers/json?all=true&filters=${filters}`);
    return (body as { Labels: Record<string, string>; State: string; Created: number }[])
      .map((c) => ({ id: c.Labels[this.#label], running: c.State === 'running', startedAt: c.Created * 1000 }));
  }
}
