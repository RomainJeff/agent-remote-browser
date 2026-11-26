// In-memory HostDriver for tests: records every call, answers agent-browser commands with canned JSON.
import { Duplex } from 'node:stream';
import type { ProfileId } from '../policy.ts';
import type { Computer, ExecResult, HostDriver } from './driver.ts';

export interface Call { op: 'ensure' | 'exec' | 'stream' | 'stop' | 'remove' | 'list'; id?: string; argv?: string[]; stdin?: string; keepVolume?: boolean }

const origin = 'https://example.com';

/** Canned output of `agent-browser --json ... <op> <args>`, after its leading flags. */
function agentBrowser(args: string[], passwordFields: number) {
  const [op, sub] = args;
  const data = op === 'open' ? { title: 'Fake page', url: args[1] }
    : op === 'get' && sub === 'url' ? { url: origin + '/' }
    : op === 'get' && sub === 'title' ? { title: 'Fake page' }
    : op === 'get' && sub === 'text' ? { origin, text: 'hello' }
    : op === 'get' && sub === 'count' ? { count: passwordFields }
    : op === 'snapshot' ? { origin, snapshot: '- button "OK" [ref=e1]' }
    : op === 'screenshot' ? { path: '/tmp/shot.png' }
    : op === 'stream' ? { port: 9223 }
    : {};
  return JSON.stringify({ success: true, data });
}

export class FakeDriver implements HostDriver {
  calls: Call[] = [];
  computers = new Map<string, Computer>();
  /** agent-browser commands starting with this (e.g. 'auth login') answer `success: false`. */
  failOn = '';
  /** agent-browser commands starting with this hang until their timeout (exit 124, like coreutils timeout). */
  slow = '';
  /** `get count input[type=password]` answer. */
  passwordFields = 1;
  /** Teach mode: HIT calls wait for this (a gesture held mid-way while others queue). */
  hold?: Promise<unknown>;
  /** Teach mode HIT answers (`node -e HIT at|focus`): { url, chain, selector? (at), live? (focus) }. */
  hit: Record<string, unknown> = {
    at: { url: origin + '/', chain: [{ role: 'button', name: 'OK', tag: 'button', count: 1, exact: 1 }, { role: 'RootWebArea', name: 'Fake page' }],
      selector: '#main > button:nth-of-type(1)' },
    focus: { url: origin + '/', chain: [{ role: 'textbox', name: 'Email', tag: 'input', count: 1, exact: 1 }, { role: 'RootWebArea', name: 'Fake page' }] },
  };

  async ensure(id: ProfileId) {
    this.calls.push({ op: 'ensure', id });
    const c = this.computers.get(id) ?? { id, running: true, startedAt: Date.now() };
    c.running = true;
    this.computers.set(id, c);
    return c;
  }

  async exec(id: ProfileId, argv: string[], { stdin, timeoutMs }: { stdin?: string; timeoutMs: number }): Promise<ExecResult> {
    this.calls.push({ op: 'exec', id, argv, ...(stdin != null && { stdin }) });
    if (argv[0] === 'node') { await this.hold; return { code: 0, stdout: JSON.stringify(this.hit[argv[3]]), stderr: '' }; }
    if (argv[0] !== 'agent-browser') return { code: 0, stdout: argv[0] === 'base64' ? 'iVBORw0K' : '', stderr: '' };
    const rest = argv.slice(1);
    while (rest[0]?.startsWith('--')) rest.splice(0, rest[0] === '--json' ? 1 : 2); // --json, --profile X, --restore X, --args X
    if (this.slow && rest.join(' ').startsWith(this.slow)) return new Promise((r) => setTimeout(r, timeoutMs, { code: 124, stdout: '', stderr: '' }));
    if (this.failOn && rest.join(' ').startsWith(this.failOn)) return { code: 1, stdout: JSON.stringify({ success: false, error: 'fake failure' }), stderr: '' };
    return { code: 0, stdout: agentBrowser(rest, this.passwordFields), stderr: '' };
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
