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
/** Admin teach mode, read-only: the accessibility chain (self, then ancestors) of the element at x,y (`at x y`) or of the
 *  focused one (`focus`), over CDP (DevToolsActivePort). Each entry: role, name, tag, type, id, attr (name attribute),
 *  placeholder, and how many elements each locator would match: for named ARIA roles `count` (same role, name contains it,
 *  case-insensitive) and `exact` (same name); `ids` (same id), `names` (same tag and name attribute), `ph` (placeholder
 *  contains it, case-insensitive). Names are cut at 300. Prints { url, chain } as JSON. Refuses unless exactly one page
 *  target exists: agent-browser may drive another tab than the one hit-tested.
 *  ponytail: iframes and shadow DOM are not looked into. */
export const HIT = `const [mode, x, y] = process.argv.slice(1);
// Run in the page: elements a #id, tag[name=…] or placeholder locator would match (attributes, not properties).
const COUNT = (id, tag, name, ph) => {
  const n = (a, f) => [...document.querySelectorAll('[' + a + ']')].filter((x) => f(x.getAttribute(a), x)).length;
  return { ids: id ? n('id', (v) => v === id) : undefined, names: name ? n('name', (v, x) => v === name && x.localName === tag) : undefined,
    ph: ph ? n('placeholder', (v) => v.toLowerCase().includes(ph.toLowerCase())) : undefined };
};
(async () => {
  const port = require('fs').readFileSync('${PROFILE}/DevToolsActivePort', 'utf8').split('\\n')[0];
  const pages = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).filter((t) => t.type === 'page'), page = pages[0];
  if (pages.length !== 1) throw Error(pages.length + ' tabs open: Record needs a single tab. Stop the browser to close them, then record again');
  const ws = new WebSocket(page.webSocketDebuggerUrl), wait = new Map(); let n = 0;
  ws.onmessage = (m) => { const d = JSON.parse(m.data); wait.get(d.id)?.(d); };
  await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
  const call = (method, params) => new Promise((r, e) => {
    wait.set(++n, (d) => d.error ? e(Error(d.error.message)) : r(d.result)); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const node = mode === 'at'
    ? (await call('DOM.getNodeForLocation', { x: +x, y: +y, ignorePointerEventsNone: true })).backendNodeId
    : (await call('DOM.describeNode', { objectId: (await call('Runtime.evaluate', { expression: 'document.activeElement' })).result.objectId })).node.backendNodeId;
  const { nodes } = await call('Accessibility.getPartialAXTree', { backendNodeId: node, fetchRelatives: true });
  const root = (await call('DOM.getDocument', { depth: 0 })).root.backendNodeId, byId = new Map(nodes.map((a) => [a.nodeId, a])), names = {}, chain = [];
  for (let a = nodes.find((b) => b.backendDOMNodeId === node) || nodes[0]; a && chain.length < 12; a = byId.get(a.parentId)) {
    const role = a.role?.value;
    if (a.ignored || !role) continue;
    const e = { role, name: String(a.name?.value || '').slice(0, 300) };
    if (a.backendDOMNodeId) {
      const d = (await call('DOM.describeNode', { backendNodeId: a.backendDOMNodeId })).node, at = {};
      for (let i = 0; i < (d.attributes || []).length; i += 2) at[d.attributes[i]] = d.attributes[i + 1];
      Object.assign(e, { tag: d.localName, type: at.type, id: at.id, attr: at.name, placeholder: at.placeholder });
      if (at.id || at.name || at.placeholder) Object.assign(e, (await call('Runtime.evaluate', { returnByValue: true,
        expression: '(' + COUNT + ')(...' + JSON.stringify([at.id, d.localName, at.name, at.placeholder]) + ')' })).result.value);
    }
    if (e.name && /^[a-z]+$/.test(role) && role !== 'generic' && role !== 'none') {
      names[role] ??= (await call('Accessibility.queryAXTree', { backendNodeId: root, role })).nodes.filter((b) => !b.ignored).map((b) => b.name?.value || '');
      e.count = names[role].filter((s) => s.toLowerCase().includes(e.name.toLowerCase())).length;
      e.exact = names[role].filter((s) => s === e.name).length;
    }
    chain.push(e);
    if (role === 'RootWebArea') break;
  }
  console.log(JSON.stringify({ url: page.url, chain }));
  process.exit(0);
})().catch((e) => { console.error(String(e.message)); process.exit(1); });`;
/** Request line limit: the largest legitimate request is a 5000-character fill plus a password on stdin. */
export const MAX_REQUEST = 64 * 1024;

const lit = <T extends string>(s: T) => z.literal(s);
const ref = z.string().regex(/^@e\d{1,6}$/);
const vault = z.string().regex(/^gw-[a-z0-9-]{1,40}$/);
const url = z.url({ protocol: /^https?$/ }).max(4096);
/** A value that cannot be read as a flag ("-" alone is a key name). */
const value = (max: number) => z.string().min(1).max(max).refine((s) => s === '-' || !s.startsWith('-'));
/** open --headers: a JSON object of header name -> printable value (a profile's custom headers for the URL's origin). */
const headers = z.string().max(4096).refine((s) => {
  try {
    const o = JSON.parse(s);
    const e = o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o) : [];
    return e.length > 0 && e.length <= 32 && e.every(([k, v]) => /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/.test(k) && typeof v === 'string' && /^[\x20-\x7e]{1,2000}$/.test(v));
  } catch { return false; }
});
/** A ref or CSS selector (get text), a CSS selector (snapshot -s): never a flag. */
const sel = value(500).refine((s) => s !== '-');

/** run_steps locators: find <kind> <value> click | fill <text>, nothing else (no hover, nth, check...).
 *  `find ... fill` has no "--" separator: the text is never a flag either. */
const action = [[lit('click')], [lit('fill'), value(5000)]] as const;
const exact = [[], [lit('--exact')]] as const;
const find = action.flatMap((act) => [
  ...exact.flatMap((ex) => [z.tuple([lit('find'), z.enum(['text', 'label', 'placeholder']), value(500), ...act, ...ex])]),
  z.tuple([lit('find'), lit('testid'), value(500), ...act]),
  z.tuple([lit('find'), lit('first'), sel, ...act]),
  z.tuple([lit('find'), lit('role'), z.string().regex(/^[a-z]{1,30}$/), ...act]),
  ...exact.map((ex) => z.tuple([lit('find'), lit('role'), z.string().regex(/^[a-z]{1,30}$/), ...act, lit('--name'), value(500), ...ex])),
]);
/** run_steps waits: never --fn (page JavaScript). A bare number is a sleep, capped at 5 s; a selector is not a number.
 *  The others take the gateway's --timeout (what is left of the run_steps budget). */
const timeout = [[], [lit('--timeout'), z.string().regex(/^\d{3,5}$/).refine((s) => +s >= 100 && +s <= 20_000)]] as const;
const wait = [
  z.tuple([lit('wait'), z.string().regex(/^\d{1,4}$/).refine((s) => +s >= 1 && +s <= 5000)]),
  ...timeout.flatMap((t) => [
    z.tuple([lit('wait'), sel.refine((s) => Number.isNaN(Number(s))), ...t]),
    z.tuple([lit('wait'), z.enum(['--text', '--url']), value(500), ...t]),
    z.tuple([lit('wait'), lit('--load'), z.enum(['load', 'domcontentloaded', 'networkidle']), ...t]),
  ]),
];

/** agent-browser subcommands the tools and the admin UI use, after AB_FLAGS. */
const agentBrowser = z.union([
  z.tuple([lit('open'), url]),
  z.tuple([lit('open'), url, lit('--headers'), headers]),
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
  ...find, ...wait,
  // run_steps login if_needed: is there a password field?
  z.tuple([lit('get'), lit('count'), lit('input[type=password]')]),
]);

/** Screenshot file written by agent-browser inside the computer. */
const png = z.string().max(512).regex(/^\/(tmp|home\/agent)\/[\w./-]+\.png$/).refine((p) => !p.split('/').includes('..'));
const other = z.union([
  z.tuple([lit('base64'), lit('-w0'), png]),
  z.tuple([lit('rm'), lit('-f'), png]),
  z.tuple([lit('cat'), lit(SESSION)]),
  z.tuple([lit('node'), lit('-e'), lit(HIT), lit('at'), z.string().regex(/^\d{1,5}$/), z.string().regex(/^\d{1,5}$/)]),
  z.tuple([lit('node'), lit('-e'), lit(HIT), lit('focus')]),
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
