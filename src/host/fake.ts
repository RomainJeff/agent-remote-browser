// In-memory HostDriver for tests: records every call, answers agent-browser commands with canned JSON.
import { Duplex } from 'node:stream';
import type { ProfileId } from '../policy.ts';
import type { Computer, ExecResult, HostDriver } from './driver.ts';

export interface Call { op: 'ensure' | 'exec' | 'stream' | 'stop' | 'remove' | 'list'; id?: string; argv?: string[]; stdin?: string; keepVolume?: boolean }

const origin = 'https://example.com';

/** Canned output of `agent-browser --json ... <op> <args>`, after its leading flags. */
function agentBrowser(args: string[]) {
  const [op, sub] = args;
  const data = op === 'open' ? { title: 'Fake page', url: args[1] }
    : op === 'get' && sub === 'url' ? { url: origin + '/' }
    : op === 'get' && sub === 'title' ? { title: 'Fake page' }
    : op === 'get' && sub === 'text' ? { origin, text: 'hello' }
    : op === 'snapshot' ? { origin, snapshot: '- button "OK" [ref=e1]' }
    : op === 'screenshot' ? { path: '/tmp/shot.png' }
    : op === 'stream' ? { port: 9223 }
    : {};
  return JSON.stringify({ success: true, data });
}

export class FakeDriver implements HostDriver {
  calls: Call[] = [];
  computers = new Map<string, Computer>();

  async ensure(id: ProfileId) {
    this.calls.push({ op: 'ensure', id });
    const c = this.computers.get(id) ?? { id, running: true, startedAt: Date.now() };
    c.running = true;
    this.computers.set(id, c);
    return c;
  }

  async exec(id: ProfileId, argv: string[], { stdin }: { stdin?: string; timeoutMs: number }): Promise<ExecResult> {
    this.calls.push({ op: 'exec', id, argv, ...(stdin != null && { stdin }) });
    if (argv[0] !== 'agent-browser') return { code: 0, stdout: argv[0] === 'base64' ? 'iVBORw0K' : '', stderr: '' };
    const rest = argv.slice(1);
    while (rest[0]?.startsWith('--')) rest.splice(0, rest[0] === '--json' ? 1 : 2); // --json, --profile X, --restore X, --args X
    return { code: 0, stdout: agentBrowser(rest), stderr: '' };
  }

  /** The relay ends at once: the live view socket closes without a 101. */
  async stream(id: ProfileId) {
    this.calls.push({ op: 'stream', id });
    return new Duplex({ read() { this.push(null); }, write(_c, _e, cb) { cb(); } });
  }

  async stop(id: ProfileId) {
    this.calls.push({ op: 'stop', id });
    const c = this.computers.get(id);
    if (c) c.running = false;
  }

  async remove(id: ProfileId, { keepVolume }: { keepVolume: boolean }) {
    this.calls.push({ op: 'remove', id, keepVolume });
    this.computers.delete(id);
  }

  async list() {
    this.calls.push({ op: 'list' });
    return [...this.computers.values()];
  }
}
