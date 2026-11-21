// Public OAuth surface for MCP clients (MCP auth spec): metadata, the allowlisted Better Auth endpoints
// (DCR, authorize, token, revoke), and two no-JS pages: admin login (password + TOTP) and consent, where the
// admin picks the scope the client gets (one profile or global).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { windowBudget, parseProfileId } from '../policy.ts';
import { requireAdmin, toHeaders } from './guards.ts';
import type { Auth } from './better-auth.ts';
import { count } from '../metrics.ts';

type Res = ServerResponse;
const MAX_CLIENTS = 1000;
const PUBLIC_API = new Set(['oauth2/authorize', 'oauth2/token', 'oauth2/register', 'oauth2/revoke']);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (res: Res, code: number, obj: unknown) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));

export function rawBody(req: IncomingMessage, max = 64e3): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Runs one Better Auth endpoint for this Node request. `body` replaces the request body (JSON). */
export async function callAuth(auth: Auth, base: string, req: IncomingMessage, path: string, body?: object) {
  const headers = toHeaders(req.headers);
  headers.delete('host'); headers.delete('content-length'); headers.delete('connection');
  // Cf-Connecting-IP (the rate limit key) was settled by the listener: see clientIp in server.ts.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (body) headers.set('content-type', 'application/json');
  return auth.handler(new Request(base + path, {
    method: req.method, headers, redirect: 'manual',
    body: !hasBody ? undefined : body ? JSON.stringify(body) : new Uint8Array(await rawBody(req)),
  }));
}

/** Copies a Fetch response (status, every header including each Set-Cookie, body) to Node. */
export async function reply(res: Res, r: Response) {
  for (const [k, v] of r.headers) if (k !== 'set-cookie') res.setHeader(k, v);
  const cookies = r.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(r.status).end(Buffer.from(await r.arrayBuffer()));
}

function page(res: Res, code: number, body: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(code, {
    ...headers,
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
  }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Remote Browser access</title><style>
:root{--bg:#f6f6f4;--panel:#fff;--ink:#1c1c1a;--muted:#6b6b66;--line:#e3e3de;--accent:#2563eb;--warn:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecece8;--muted:#9a9a93;--line:#2e2e2b;--accent:#60a5fa;--warn:#fb923c}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:24px;max-width:420px;width:100%;box-sizing:border-box}
h1{font-size:18px;margin:0 0 8px}p{color:var(--muted);margin:0 0 16px}b{color:var(--ink)}
input,select{font:inherit;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);margin-bottom:12px}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;width:100%}
button.alt{background:transparent;color:var(--ink);border-color:var(--line);margin-top:8px}
.err{color:var(--warn)}.mono{font-family:ui-monospace,monospace;word-break:break-all}</style></head><body><main>${body}</main></body></html>`);
}

/** Public routes on the MCP listener. Returns false when the request is not one of them. */
export function createAuthRoutes(db: DatabaseSync, auth: Auth, pending: Map<string, string>, base: string) {
  const origin = new URL(base).origin;
  const registerBudget = windowBudget(20, 3600_000);
  const sameOrigin = (req: IncomingMessage) => req.headers.origin === origin;
  const hidden = (q: string) => `<input type="hidden" name="oauth_query" value="${esc(q)}">`;

  const loginForm = (res: Res, q: string, err?: string) => page(res, err ? 401 : 200, `<h1>Admin sign-in</h1>
<p>An MCP client asks to connect to this remote browser.</p>${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/login">${hidden(q)}
<input type="email" name="email" placeholder="Email" autocomplete="username" required autofocus>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button>Continue</button></form>`);
  const totpForm = (res: Res, q: string, err?: string, cookies: string[] = []) => page(res, err ? 401 : 200, `<h1>Two-factor code</h1>
<p>Enter the 6-digit code from your authenticator app.</p>${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/login">${hidden(q)}
<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus>
<button>Verify</button></form>
<form method="post" action="/login">${hidden(q)}
<input name="backupCode" placeholder="Lost the app? A backup code (xxxxx-xxxxx)" autocomplete="off" maxlength="32" required>
<button class="alt">Use a backup code</button></form>`, cookies.length ? { 'set-cookie': cookies } : {});

  async function form(req: IncomingMessage) {
    return Object.fromEntries(new URLSearchParams((await rawBody(req, 8e3)).toString())) as Record<string, string>;
  }
  const toLocal = (res: Res, url: unknown) => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
    ? res.writeHead(302, { location: url, 'cache-control': 'no-store' }).end() : res.writeHead(400).end();

  // CIMD rows (metadata fetched from the client_id URL) carry clientDiscoveryId 'cimd'; anything else is open DCR.
  const clientOf = (id: string) => {
    const c = db.prepare('SELECT name, createdAt, clientDiscoveryId d FROM oauthClient WHERE clientId = ?').get(id) as
      { name: string | null; createdAt: string | null; d: string | null } | undefined;
    return { id, name: c?.name || 'an MCP client', dcr: c?.d !== 'cimd', createdAt: c?.createdAt ?? null };
  };
  const age = (iso: string | null) => {
    const m = iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000)) : NaN;
    return Number.isNaN(m) ? 'unknown' : m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  const GLOBAL_WARNING = 'Unverified client with Global access: it could manage, lease and delete every profile and its saved logins. Only allow this if you registered this client yourself, just now.';

  /** `confirmGlobal`: the second page an unverified (DCR) client gets after picking Global. */
  function consentPage(res: Res, q: string, confirmGlobal = false) {
    const p = new URLSearchParams(q), c = clientOf(p.get('client_id') ?? '');
    let host = '', loopback = false;
    try { const u = new URL(p.get('redirect_uri') ?? ''); host = u.host; loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch {}
    const profiles = (db.prepare('SELECT id FROM profiles ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    const choice = confirmGlobal ? `<input type="hidden" name="scope" value="global"><input type="hidden" name="confirm" value="global">
<p class="err"><b>${esc(GLOBAL_WARNING)}</b></p>`
      : `<select name="scope">${profiles.map((id) => `<option value="profile:${esc(id)}">Profile ${esc(id)}</option>`).join('')}
<option value="global">Global: manage and lease every profile${c.dcr ? ' (not recommended for an unverified client)' : ''}</option></select>`;
    page(res, 200, `<h1>Connect ${esc(c.name)}</h1>
<p>It will drive a remote browser with the access you pick. Afterwards you return to <b>${esc(host)}</b>.</p>
<p>Client ID <b class="mono">${esc(c.id)}</b><br>${c.dcr
      ? '<span class="err">Unverified client (client non vérifié): registered itself, its name is self-declared.</span>'
      : 'Verified by its metadata URL (CIMD): the name comes from that domain.'}<br>Registered ${esc(age(c.createdAt))}.</p>
${loopback ? '<p>Loopback redirect: the grant goes to an app on this computer. Allow only if you just started that app.</p>' : ''}
<form method="post" action="/consent">${hidden(q)}
${choice}
<button name="accept" value="true">Allow</button><button class="alt" name="accept" value="false">Deny</button></form>`);
  }

  async function handle(req: IncomingMessage, res: Res): Promise<boolean> {
    const url = new URL(req.url!, base), path = url.pathname, q = url.search.slice(1);

    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: base + '/mcp', authorization_servers: [base + '/api/auth'], bearer_methods_supported: ['header'] }), true;
    }
    if (/^(\/api\/auth)?\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/api\/auth)?$/.test(path)) {
      return json(res, 200, await auth.api.getOAuthServerConfig()), true;
    }

    if (path.startsWith('/api/auth/')) {
      const ep = path.slice('/api/auth/'.length);
      if (!PUBLIC_API.has(ep)) return false; // the admin's own endpoints (sign-in...) live on the admin UI
      if (ep === 'oauth2/register' && req.method === 'POST') {
        // ponytail: process-wide budget and row cap against DCR floods; purgeClients() drops the unused ones daily.
        const n = (db.prepare('SELECT count(*) n FROM oauthClient').get() as { n: number }).n;
        if (n >= MAX_CLIENTS || !registerBudget()) return json(res, 429, { error: 'temporarily_unavailable' }), true;
      }
      return await reply(res, await callAuth(auth, base, req, path + url.search)), true;
    }

    if (path === '/login' && req.method === 'GET') return loginForm(res, q), true;
    if (path === '/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return res.writeHead(403).end(), true;
      const b = await form(req), oq = b.oauth_query ?? '';
      if (!b.code && !b.backupCode) {
        const r = await callAuth(auth, base, req, '/api/auth/sign-in/email', { email: b.email, password: b.password, oauth_query: oq });
        const j = await r.json().catch(() => ({}));
        if (r.status === 429) return count('arb_auth_failures_total', { kind: 'rate_limited' }), loginForm(res, oq, 'Too many attempts, wait a minute.'), true;
        if (!r.ok) count('arb_auth_failures_total', { kind: 'password' });
        // No twoFactorRedirect = TOTP not enrolled: refuse (its session cookie is not passed on).
        if (!r.ok || !j.twoFactorRedirect) return loginForm(res, oq, r.ok ? 'Two-factor not enrolled: run `arb admin reset-2fa`.' : 'Invalid email or password.'), true;
        return totpForm(res, oq, undefined, r.headers.getSetCookie()), true;
      }
      const r = await callAuth(auth, base, req, `/api/auth/two-factor/${b.code ? 'verify-totp' : 'verify-backup-code'}`, { code: b.code || b.backupCode, oauth_query: oq });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) count('arb_auth_failures_total', { kind: r.status === 429 ? 'rate_limited' : 'totp' });
      if (!r.ok) return totpForm(res, oq, r.status === 429 ? 'Too many attempts, wait a minute.' : 'Invalid or expired code. Sign in again if this repeats.'), true;
      res.setHeader('set-cookie', r.headers.getSetCookie());
      return toLocal(res, j.url), true;
    }

    if (path === '/consent' && req.method === 'GET') {
      if (!await requireAdmin(auth, req.headers)) return res.writeHead(302, { location: '/login?' + q, 'cache-control': 'no-store' }).end(), true;
      return consentPage(res, q), true;
    }
    if (path === '/consent' && req.method === 'POST') {
      if (!sameOrigin(req)) return res.writeHead(403).end(), true;
      const s = await requireAdmin(auth, req.headers);
      const b = await form(req);
      if (!s) return res.writeHead(302, { location: '/login?' + (b.oauth_query ?? '') }).end(), true;
      const scope = b.scope === 'global' ? 'global' : b.scope?.startsWith('profile:') && parseProfileId(b.scope.slice(8))
        && db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(b.scope.slice(8)) ? b.scope : null;
      if (!scope) return res.writeHead(400).end(), true;
      const oq = b.oauth_query ?? '';
      if (scope === 'global' && b.accept === 'true' && b.confirm !== 'global' && clientOf(new URLSearchParams(oq).get('client_id') ?? '').dcr) return consentPage(res, oq, true), true;
      pending.set(s.session.id, scope);
      try {
        req.headers.accept = 'application/json';
        const r = await callAuth(auth, base, req, '/api/auth/oauth2/consent', { accept: b.accept === 'true', oauth_query: b.oauth_query });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || typeof j.url !== 'string') return res.writeHead(r.status === 429 ? 429 : 400).end(), true;
        return res.writeHead(302, { location: j.url, 'cache-control': 'no-store' }).end(), true;
      } finally { pending.delete(s.session.id); }
    }
    return false;
  }
  return { handle };
}
