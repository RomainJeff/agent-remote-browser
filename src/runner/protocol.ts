// Gateway -> runner RPC: what the gateway may ask of the privileged runner, validated field by field by the runner.
// Transport: one connection per request on a Unix socket; one JSON line in, one JSON line out
// ({ ok: true, result } | { ok: false, error }). `stream` answers { ok: true } and then relays raw bytes both ways.
// The gateway never names an image, a mount, a container or a command line: only a profile id and one of the
// argv shapes below. Anything else is refused before the Docker Engine API is reached.
import type { Socket } from 'node:net';
import { z } from 'zod';
import { validId, type ProfileId } from '../policy.ts';

/** Chrome profile (IndexedDB, persistent cookies) + --restore state (session cookies, localStorage), both on the volume. */
export const PROFILE = '/home/agent/.agent-browser/profile';
/** Every agent-browser call starts with exactly these flags. */
export const AB_FLAGS = ['--json', '--profile', PROFILE, '--restore', 'agent',
  // --no-sandbox: the container is the sandbox (Chrome's own needs caps we dropped).
  '--args', '--no-sandbox,--proxy-server=http://127.0.0.1:3128,--proxy-bypass-list=<-loopback>,--disable-quic'];
/** --restore state file, read by the admin UI (saved every 30 s by agent-browser). */
export const SESSION = '/home/agent/.agent-browser/sessions/agent-default.json';
/** Admin copy during takeover: selected text of the focused field, else of the page. Never a password field's.
 *  ponytail: selections inside iframes are not seen; walk frames if that matters. */
export const SELECTION = "(e=>e&&e.type!=='password'&&e.selectionEnd>e.selectionStart?e.value.slice(e.selectionStart,e.selectionEnd):getSelection().toString())(document.activeElement)";
/** Request line limit: the largest legitimate request is a 5000-character fill plus a password on stdin. */
export const MAX_REQUEST = 64 * 1024;

const lit = <T extends string>(s: T) => z.literal(s);
const ref = z.string().regex(/^@e\d{1,6}$/);
const vault = z.string().regex(/^gw-[a-z0-9-]{1,40}$/);
const url = z.url({ protocol: /^https?$/ }).max(4096);
/** A value that cannot be read as a flag ("-" alone is a key name). */
const value = (max: number) => z.string().min(1).max(max).refine((s) => s === '-' || !s.startsWith('-'));
/** A ref or CSS selector (get text), a CSS selector (snapshot -s): never a flag. */
const sel = value(500).refine((s) => s !== '-');

/** agent-browser subcommands the tools and the admin UI use, after AB_FLAGS. */
const agentBrowser = z.union([
  z.tuple([lit('open'), url]),
  z.tuple([lit('snapshot'), lit('-i')]),
  z.tuple([lit('snapshot'), lit('-i'), lit('-c')]),
  z.tuple([lit('snapshot'), lit('-i'), lit('-s'), sel]),
  z.tuple([lit('snapshot'), lit('-i'), lit('-c'), lit('-s'), sel]),
  z.tuple([lit('get'), lit('text'), sel]),
  z.tuple([lit('get'), z.enum(['url', 'title'])]),
  z.tuple([lit('click'), ref]),
  z.tuple([lit('fill'), ref, lit('--'), z.string().max(5000)]),
  z.tuple([lit('press'), value(30)]),
  z.tuple([z.enum(['back', 'screenshot', 'close'])]),
  z.tuple([lit('stream'), lit('status')]),
  // Admin clipboard during takeover. inserttext has no "--" separator: a leading dash is sent alone first.
  z.tuple([lit('keyboard'), lit('inserttext'), value(5000)]),
  z.tuple([lit('eval'), lit(SELECTION)]),
  z.tuple([lit('auth'), lit('save'), vault, lit('--url'), z.url({ protocol: /^https$/ }).max(4096), lit('--username'), value(200), lit('--password-stdin')]),
  z.tuple([lit('auth'), z.enum(['login', 'delete']), vault]),
  z.tuple([lit('auth'), lit('login'), vault, lit('--no-navigate')]),
]);

/** Screenshot file written by agent-browser inside the computer. */
const png = z.string().max(512).regex(/^\/(tmp|home\/agent)\/[\w./-]+\.png$/).refine((p) => !p.split('/').includes('..'));
const other = z.union([
  z.tuple([lit('base64'), lit('-w0'), png]),
  z.tuple([lit('rm'), lit('-f'), png]),
  z.tuple([lit('cat'), lit(SESSION)]),
]);

export const argvAllowed = (a: string[]) => !a.some((s) => s.includes('\0')) && (a[0] === 'agent-browser'
  ? AB_FLAGS.every((f, i) => a[i + 1] === f) && agentBrowser.safeParse(a.slice(AB_FLAGS.length + 1)).success
  : other.safeParse(a).success);

const id = z.string().refine(validId).transform((s) => s as ProfileId);
const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) => z.strictObject({ op: z.literal(name), ...shape });

export const Request = z.discriminatedUnion('op', [
  op('ensure', { id }),
  op('exec', {
    id,
    argv: z.array(z.string().max(5000)).max(16).refine(argvAllowed, 'argv not allowed'),
    stdin: z.string().max(4096).optional(),
    timeoutMs: z.int().min(1000).max(120_000),
  }),
  op('stream', { id }),
  op('stop', { id }),
  op('remove', { id, keepVolume: z.boolean() }),
  op('list', {}),
]);
export type Request = z.input<typeof Request>;

/** First line of a socket, without the newline. Bytes after it are put back, the socket is left paused.
 *  Rejects on close, error, or `max` bytes without a newline. */
export const readLine = (sock: Socket, max: number) => new Promise<string>((resolve, reject) => {
  let buf = Buffer.alloc(0);
  const done = (e?: Error, line?: string) => {
    sock.off('data', data).off('error', done).off('close', closed);
    if (e) reject(e); else resolve(line!);
  };
  const closed = () => done(Error('connection closed'));
  const data = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf(10);
    if (i < 0 ? buf.length > max : i > max) { sock.destroy(); return done(Error('line too long')); }
    if (i < 0) return;
    sock.pause();
    if (i + 1 < buf.length) sock.unshift(buf.subarray(i + 1));
    done(undefined, buf.subarray(0, i).toString('utf8'));
  };
  sock.on('data', data).on('error', done).on('close', closed);
});
