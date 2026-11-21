// OAuth 2.1 authorization server for the MCP endpoint (MCP auth spec): metadata, Dynamic Client
// Registration (RFC 7591), authorization code + PKCE S256, refresh token rotation.
// The consent page asks for an access token: a profile token (-> that profile) or the global token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hash, redirectUriOk, pkceOk, windowBudget, type Principal } from '../policy.ts';
import type { Store, OAuthClient } from '../store/state.ts';

type Res = ServerResponse;
type Body = Record<string, any>;
interface Pending { client_id: string; redirect_uri: string; explicitRedirect: boolean; state?: string; challenge: string; tries: number; exp: number }
interface Code { client_id: string; redirect_uri: string; explicitRedirect: boolean; credentialHash: string; challenge: string; principal: Principal; exp: number }

const rand = () => randomBytes(24).toString('base64url');
const MAX_CLIENTS = 1000;

const json = (res: Res, code: number, obj: unknown) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c) => { size += c.length; if (size > 64e3) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve((req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw)));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function page(res: Res, code: number, body: string) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff',
    'content-security-policy': "default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Remote Browser access</title><style>
:root{--bg:#f6f6f4;--panel:#fff;--ink:#1c1c1a;--muted:#6b6b66;--line:#e3e3de;--accent:#2563eb;--warn:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecece8;--muted:#9a9a93;--line:#2e2e2b;--accent:#60a5fa;--warn:#fb923c}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:24px;max-width:420px;width:100%;box-sizing:border-box}
h1{font-size:18px;margin:0 0 8px}p{color:var(--muted);margin:0 0 16px}b{color:var(--ink)}
input{font:inherit;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);margin-bottom:12px}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;width:100%}
.err{color:var(--warn)}</style></head><body><main>${body}</main></body></html>`);
}

const errorPage = (res: Res, msg: string) => page(res, 400, `<h1>Authorization error</h1><p class="err">${esc(msg)}</p>`);

function redirectWith(res: Res, uri: string, params: Record<string, string | undefined>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  res.writeHead(302, { location: u.href, 'cache-control': 'no-store' }).end();
}

/** OAuth routes bound to one store. Budgets and pending authorizations live per instance, in memory. */
export function createOAuth(store: Store, publicUrl?: string) {
  const { state, save, principalForStatic, issueTokens } = store;
  const pending = new Map<string, Pending>(); // authorization requests waiting for the token (10 min)
  const codes = new Map<string, Code>();      // authorization codes (5 min)
  const registerBudget = windowBudget(20, 3600_000);
  const consentBudget = windowBudget(40, 60_000);

  /** Public base URL: PUBLIC_URL, else what the client used (quick tunnel host => https; refused in production by config). */
  function baseUrl(req: IncomingMessage) {
    if (publicUrl) return publicUrl.replace(/\/$/, '');
    const host = req.headers.host ?? '';
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    if (!local && !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(host)) throw Error('Configure PUBLIC_URL');
    return `${local ? 'http' : 'https'}://${host}`;
  }
  const wwwAuthenticate = (req: IncomingMessage) => `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`;

  function consent(res: Res, id: string, p: Pending, err?: string) {
    const c = state.clients[p.client_id];
    page(res, err ? 401 : 200, `<h1>Connect ${esc(c.client_name || 'an MCP client')}</h1>
<p>It will use a remote browser. Paste the <b>profile token</b> (or the global token) from the admin UI.
After this, you return to <b>${esc(new URL(p.redirect_uri).host)}</b>.</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/authorize"><input type="hidden" name="pending" value="${esc(id)}">
<input type="password" name="token" placeholder="acp_… or acg_…" autocomplete="off" required autofocus>
<button>Connect</button></form>`);
  }

  function clientAuthOk(client: OAuthClient, body: Body, req: IncomingMessage) {
    if (!client.secretHash) return true; // public client: PKCE is the proof
    let secret = body.client_secret;
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization || '');
    if (basic) secret = decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':'));
    return !!secret && timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(client.secretHash));
  }

  /** Handles the OAuth routes. Returns false when the request is not one of them. */
  async function handle(req: IncomingMessage, res: Res, { audit }: { audit: (e: object) => void }): Promise<boolean> {
    const url = new URL(req.url!, 'http://x'), path = url.pathname, base = baseUrl(req);

    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] }), true;
    }
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      }), true;
    }

    if (path === '/register' && req.method === 'POST') {
      if (!registerBudget()) return json(res,429,{error:'temporarily_unavailable'}), true;
      const b = await readBody(req);
      const uris = b.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(redirectUriOk)) {
        return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'https redirect URIs required (http only for loopback)' }), true;
      }
      const method = b.token_endpoint_auth_method || 'client_secret_basic';
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return json(res, 400, { error: 'invalid_client_metadata' }), true;
      const ids = Object.keys(state.clients);
      if (ids.length >= MAX_CLIENTS) return json(res,429,{error:'temporarily_unavailable'}), true;
      const client_id = `acc_${rand()}`, secret = method === 'none' ? undefined : `accs_${rand()}`;
      const client_name = String(b.client_name || '').slice(0, 100);
      state.clients[client_id] = { redirect_uris: uris, client_name, secretHash: secret && hash(secret), createdAt: Date.now() };
      save();
      return json(res, 201, {
        client_id, ...(secret && { client_secret: secret, client_secret_expires_at: 0 }), client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name, redirect_uris: uris, token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }), true;
    }

    if (path === '/authorize' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const client = Object.hasOwn(state.clients, q.client_id || '') ? state.clients[q.client_id] : null;
      if (!client) return errorPage(res, 'Unknown client. Reconnect the MCP server from your app.'), true;
      const redirect_uri = q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
      if (!redirectUriOk(redirect_uri) || !client.redirect_uris.includes(redirect_uri)) return errorPage(res, 'redirect_uri does not match the registered client.'), true;
      // From here on, errors go back to the (validated) client redirect.
      if (q.response_type !== 'code') return redirectWith(res, redirect_uri, { error: 'unsupported_response_type', state: q.state }), true;
      if (!/^[a-zA-Z0-9_-]{43}$/.test(q.code_challenge || '') || q.code_challenge_method !== 'S256') {
        return redirectWith(res, redirect_uri, { error: 'invalid_request', error_description: 'PKCE S256 required', state: q.state }), true;
      }
      for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
      if (pending.size >= 1000) return errorPage(res, 'Too many pending authorizations, retry later.'), true;
      const id = rand();
      const p = { client_id: q.client_id, redirect_uri, explicitRedirect: q.redirect_uri !== undefined, state: q.state, challenge: q.code_challenge, tries: 0, exp: Date.now() + 600_000 };
      pending.set(id, p);
      return consent(res, id, p), true;
    }

    if (path === '/authorize' && req.method === 'POST') {
      const b = await readBody(req);
      const p = pending.get(b.pending);
      if (!p || p.exp < Date.now()) return errorPage(res, 'This authorization expired. Restart the connection from your app.'), true;
      if (!consentBudget()) return json(res,429,{error:'temporarily_unavailable'}), true;
      const principal = principalForStatic(b.token);
      if (!principal) {
        if (++p.tries >= 5) pending.delete(b.pending);
        audit({ agent: 'oauth', tool: 'oauth:authorize', ok: false, err: 'bad token' });
        return consent(res, b.pending, p, 'Invalid token.'), true;
      }
      pending.delete(b.pending);
      for (const [k,v] of codes) if (v.exp <= Date.now()) codes.delete(k);
      const code = rand();
      codes.set(code, { client_id: p.client_id, redirect_uri: p.redirect_uri, explicitRedirect: p.explicitRedirect, credentialHash: hash(b.token), challenge: p.challenge, principal, exp: Date.now() + 300_000 });
      audit({ agent: principal.global ? 'global' : principal.profile, tool: 'oauth:authorize', args: { client: state.clients[p.client_id]?.client_name }, ok: true });
      return redirectWith(res, p.redirect_uri, { code, state: p.state, iss: base }), true;
    }

    if (path === '/token' && req.method === 'POST') {
      const b = await readBody(req);
      const basicId = /^Basic (.+)$/i.exec(req.headers.authorization || '');
      const client_id: string = b.client_id || (basicId && decodeURIComponent(Buffer.from(basicId[1], 'base64').toString().split(':')[0])) || '';
      const client = Object.hasOwn(state.clients, client_id) ? state.clients[client_id] : null;
      if (!client || !clientAuthOk(client, b, req)) return json(res, 401, { error: 'invalid_client' }), true;

      if (b.grant_type === 'authorization_code') {
        const c = codes.get(b.code);
        codes.delete(b.code); // single use, even on failure
        if (!c || c.exp < Date.now() || c.client_id !== client_id || ((c.explicitRedirect || b.redirect_uri !== undefined) && b.redirect_uri !== c.redirect_uri) || !pkceOk(b.code_verifier, c.challenge)) {
          return json(res, 400, { error: 'invalid_grant' }), true;
        }
        const currentHash = c.principal.global ? state.globalTokenHash : store.profile(c.principal.profile)?.tokenHash;
        if (currentHash !== c.credentialHash) return json(res,400,{error:'invalid_grant'}), true;
        return json(res, 200, issueTokens(c.principal, client_id)), true;
      }
      if (b.grant_type === 'refresh_token') {
        const h = hash(b.refresh_token || ''), t = state.tokens[h];
        if (!t || t.kind !== 'refresh' || t.client !== client_id || t.exp < Date.now()) return json(res, 400, { error: 'invalid_grant' }), true;
        delete state.tokens[h]; // rotation
        return json(res, 200, issueTokens(t.principal, client_id)), true;
      }
      return json(res, 400, { error: 'unsupported_grant_type' }), true;
    }
    return false;
  }
  return { handle, wwwAuthenticate };
}
