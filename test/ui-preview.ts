// Throwaway local gateway for ui-diff captures of the admin UI (ui-diff.config.json runs it with PORT set).
// Synthetic data only: a fresh data dir, a fake host driver, an admin created and signed in the real way (password,
// then TOTP), and a little seed data through the admin API. GET /?signed-in also sets that admin's session cookies,
// so a capture of /?signed-in#/profiles is signed in while / stays the sign-in screen.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { main } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { FakeDriver } from '../src/host/fake.ts';
import { start } from '../src/server.ts';
import { totp } from './totp.ts';

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const port = Number(process.env.PORT), dir = mkdtempSync(join(tmpdir(), 'arb-ui-preview-'));
// PUBLIC_URL is fixed so the MCP URL the pages show is the same on base and head; the MCP listener gets any free port.
const env = {
  ...process.env, NODE_ENV: 'development', ADMIN_PORT: String(port), PORT: String(await freePort()), PUBLIC_URL: 'http://localhost:8787', DATA_DIR: dir,
  LOGIN_KEY_FILE: join(dir, 'login_key'), AUDIT_FILE: join(dir, 'audit.jsonl'), KILL_FILE: join(dir, 'KILL'),
  BETTER_AUTH_SECRET: 'ui-preview-local-only-not-a-secret-0000',
};
const base = `http://localhost:${port}`;

/** Enrolls through the CLI, like an operator; returns the TOTP URI. */
async function enroll(args: string[], password: string) {
  let uri = '';
  const answers = [() => password, () => totp(uri)];
  const code = await main(args, env, (l) => { if (l.startsWith('otpauth://')) uri = l; }, async () => answers.shift()!());
  if (code !== 0) throw Error(`${args.join(' ')} failed`);
  return uri;
}

const password = 'ui-preview-password';
const uri = await enroll(['admin', 'create', 'admin@example.com'], password);
await enroll(['user', 'create', 'member@example.com'], password);
const app = await start(loadConfig(env), new FakeDriver());

// Until signed in, /?signed-in answers 503: it is ui-diff's readyPath, so captures wait for the session.
let cookies: string[] = [];
const [handle] = app.admin.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[];
app.admin.removeAllListeners('request').on('request', (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && req.url === '/?signed-in') {
    if (!cookies.length) return res.writeHead(503).end();
    res.setHeader('set-cookie', cookies);
  }
  handle(req, res);
});

const jar = () => cookies.map((c) => c.split(';')[0]).join('; ');
async function call(path: string, body: unknown) {
  const r = await fetch(base + path, { method: 'POST', headers: { origin: base, cookie: jar(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw Error(`${path}: ${r.status} ${await r.text()}`);
  cookies = [...cookies.filter((c) => !r.headers.getSetCookie().some((n) => n.split('=')[0] === c.split('=')[0])), ...r.headers.getSetCookie()];
}
await call('/api/auth/sign-in/email', { email: 'admin@example.com', password });
await call('/api/auth/two-factor/verify-totp', { code: totp(uri) });
for (const [id, allow] of [['shop', ['shop.example.com']], ['bank', ['bank.example.com', 'login.example.com']]]) await call('/api/profiles', { id, allow });
await call('/api/users/invite', { email: 'new@example.com' });
console.log(`ui preview ready on ${base} (data in ${dir})`);
