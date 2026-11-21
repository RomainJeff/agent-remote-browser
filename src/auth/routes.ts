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
  // A JSON body = our own API call, even when relaying a browser form POST: strip the navigation hints, or
  // Better Auth answers with a 302 instead of the JSON ({twoFactorRedirect}, {url}) the caller reads.
  if (body) {
    headers.set('content-type', 'application/json'); headers.set('accept', 'application/json');
    for (const h of ['sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) headers.delete(h);
  }
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
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
  }).end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Remote Browser : accès</title><style>
:root{color-scheme:light;--sans:Mulish,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:#F6F7F8;color:#1F2226;font:14px/20px var(--sans);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:100vh;padding:32px 16px}
.brand{display:flex;align-items:center;gap:12px}.brand i{width:36px;height:36px;border-radius:8px;background:#00543C;color:#fff;display:grid;place-items:center;font:800 16px/1 var(--sans);font-style:normal}
.brand b{display:block;font-size:15px;font-weight:800}.brand span{font-size:12px;line-height:16px;color:#585F66}
main{background:#fff;border:1px solid #CFD4D8;border-radius:8px;padding:32px;max-width:460px;width:100%;display:flex;flex-direction:column;gap:16px}
h1{font-size:24px;line-height:32px;font-weight:800;margin:0}p{color:#585F66;margin:0}b{color:#1F2226}
form{display:flex;flex-direction:column;gap:12px;margin:0}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:16px;font-weight:700;color:#585F66}
input:not([type=radio]){font:14px/20px var(--sans);width:100%;min-height:40px;padding:0 12px;border:1px solid #CFD4D8;border-radius:4px;background:#fff;color:#1F2226}
input:focus{outline:2px solid #00543C;outline-offset:-1px;border-color:transparent}
.code{font:600 22px/32px 'Roboto Mono',ui-monospace,monospace!important;letter-spacing:.3em;text-align:center}
button{font:600 14px/20px var(--sans);min-height:40px;padding:0 16px;border-radius:4px;border:1px solid #00543C;background:#00543C;color:#fff;cursor:pointer;width:100%}
button:hover{background:#003526}button.alt{background:#fff;color:#1F2226;border-color:#CFD4D8}button.alt:hover{background:#F6F7F8}
button:focus-visible,input:focus-visible{outline:2px solid #00543C;outline-offset:2px}
.step{font-size:12px;font-weight:700;color:#00543C;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
.err,.warn,.note{padding:12px 14px;border-radius:4px;border:1px solid}
.err{background:#FDE5DC;color:#A8310C;border-color:#F6B9A3}.warn{background:#FFF6E4;color:#8A5C00;border-color:#FFD02F}.note{background:#F0E5FF;color:#4A1F8C;border-color:#D9C2FF}
.err b,.warn b{color:inherit}
.or{display:flex;align-items:center;gap:12px;font-size:12px;color:#585F66}.or::before,.or::after{content:"";flex:1;border-top:1px solid #E9EBEC}
.opt{flex-direction:row;align-items:flex-start;gap:10px;padding:12px;border:1px solid #CFD4D8;border-radius:4px;font-size:14px;line-height:20px;font-weight:400;color:#1F2226;cursor:pointer}
.opt:has(input:checked){border-color:#00543C;background:#E2F2EE}.opt input{margin:3px 0 0;accent-color:#00543C}.opt.g:has(input:checked){border-color:#D43F11;background:#FDE5DC}
.opt small{display:block;color:#585F66;font-size:12px;line-height:16px}
fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}legend{font-size:12px;font-weight:700;color:#585F66;padding:0;margin-bottom:8px}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px}dt{color:#585F66;font-weight:700}dd{margin:0}
ul{margin:0;padding-left:20px;color:#585F66;display:flex;flex-direction:column;gap:4px}
.pill{display:inline-block;padding:0 10px;border-radius:999px;font-size:12px;font-weight:700;line-height:24px}.pill.ok{background:#E2F2EE;color:#00543C}.pill.ko{background:#FDE5DC;color:#A8310C}
.row{display:flex;gap:8px}.row button{flex:1}
.hint{font-size:12px;line-height:16px;color:#585F66;text-align:center;max-width:460px}
.mono{font-family:'Roboto Mono',ui-monospace,monospace;font-size:13px;word-break:break-all}</style></head><body>
<div class="brand"><i>A</i><div><b>Agent Remote Browser</b><span>Accès des agents MCP</span></div></div>
<main>${body}</main></body></html>`);
}

/** Public routes on the MCP listener. Returns false when the request is not one of them. */
export function createAuthRoutes(db: DatabaseSync, auth: Auth, pending: Map<string, string>, base: string) {
  const origin = new URL(base).origin;
  const registerBudget = windowBudget(20, 3600_000);
  const sameOrigin = (req: IncomingMessage) => req.headers.origin === origin;
  const hidden = (q: string) => `<input type="hidden" name="oauth_query" value="${esc(q)}">`;
  const error = (err?: string) => err ? `<p class="err" role="alert">${esc(err)}</p>` : '';

  const loginForm = (res: Res, q: string, err?: string) => page(res, err ? 401 : 200, `<div><div class="step">Étape 1 sur 2</div><h1>Connexion administrateur</h1></div>
<p>Un client MCP demande à piloter ce navigateur distant. Connectez-vous pour choisir ce qu'il pourra faire.</p>${error(err)}
<form method="post" action="/login">${hidden(q)}
<label>E-mail<input type="email" name="email" autocomplete="username" required autofocus></label>
<label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
<button>Continuer</button></form>`);
  const totpForm = (res: Res, q: string, err?: string, cookies: string[] = []) => page(res, err ? 401 : 200, `<div><div class="step">Étape 2 sur 2</div><h1>Code de double authentification</h1></div>
<p>Saisissez le code à 6 chiffres de votre application d'authentification.</p>${error(err)}
<form method="post" action="/login">${hidden(q)}
<label>Code à 6 chiffres<input class="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus></label>
<button>Vérifier</button></form>
<div class="or">application perdue ?</div>
<form method="post" action="/login">${hidden(q)}
<label>Code de secours<input class="mono" name="backupCode" placeholder="xxxxx-xxxxx" autocomplete="off" maxlength="32" required></label>
<button class="alt">Utiliser un code de secours</button></form>`, cookies.length ? { 'set-cookie': cookies } : {});

  async function form(req: IncomingMessage) {
    return Object.fromEntries(new URLSearchParams((await rawBody(req, 8e3)).toString())) as Record<string, string>;
  }
  const toLocal = (res: Res, url: unknown) => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
    ? res.writeHead(302, { location: url, 'cache-control': 'no-store' }).end() : res.writeHead(400).end();

  // CIMD rows (metadata fetched from the client_id URL) carry clientDiscoveryId 'cimd'; anything else is open DCR.
  const clientOf = (id: string) => {
    const c = db.prepare('SELECT name, createdAt, clientDiscoveryId d FROM oauthClient WHERE clientId = ?').get(id) as
      { name: string | null; createdAt: string | null; d: string | null } | undefined;
    return { id, name: c?.name || 'un client MCP', dcr: c?.d !== 'cimd', createdAt: c?.createdAt ?? null };
  };
  const age = (iso: string | null) => {
    const m = iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000)) : NaN;
    return Number.isNaN(m) ? 'à une date inconnue' : m < 1 ? 'à l’instant' : m < 120 ? `il y a ${m} min` : m < 2880 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} jours`;
  };
  const GLOBAL_WARNING = 'Client non vérifié avec accès Global : il pourrait gérer, louer et supprimer tous les profils et leurs identifiants. N\'acceptez que si vous venez d\'enregistrer ce client vous-même.';

  /** `confirmGlobal`: the second page an unverified (DCR) client gets after picking Global. */
  function consentPage(res: Res, q: string, confirmGlobal = false) {
    const p = new URLSearchParams(q), c = clientOf(p.get('client_id') ?? '');
    let host = '', loopback = false;
    try { const u = new URL(p.get('redirect_uri') ?? ''); host = u.host; loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch {}
    const profiles = (db.prepare('SELECT id FROM profiles ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    const choice = confirmGlobal ? `<input type="hidden" name="scope" value="global"><input type="hidden" name="confirm" value="global">
<p class="err"><b>${esc(GLOBAL_WARNING)}</b></p>`
      : `<fieldset><legend>Accès accordé</legend>${profiles.map((id, i) => `<label class="opt"><input type="radio" name="scope" value="profile:${esc(id)}"${i ? '' : ' checked'}><span>Profil <b class="mono">${esc(id)}</b><small>Uniquement ce navigateur, ses domaines et ses identifiants.</small></span></label>`).join('')}
<label class="opt g"><input type="radio" name="scope" value="global"${profiles.length ? '' : ' checked'}><span>Global : gère et loue tous les profils<small>${c.dcr ? 'Déconseillé pour un client non vérifié.' : 'Y compris les profils créés plus tard.'}</small></span></label></fieldset>`;
    page(res, 200, `<h1>Connecter ${esc(c.name)}</h1>
<p>Il pilotera un navigateur distant avec l'accès choisi. Vous reviendrez ensuite sur <b>${esc(host)}</b>.</p>
<dl><dt>Client ID</dt><dd class="mono">${esc(c.id)}</dd>
<dt>Origine</dt><dd>${c.dcr
      ? '<span class="pill ko">Client non vérifié</span> Il s\'est enregistré seul : son nom est auto-déclaré.'
      : '<span class="pill ok">Vérifié</span> Vérifié par son URL de métadonnées (CIMD) : le nom vient de ce domaine.'}</dd>
<dt>Enregistré</dt><dd>Enregistré ${esc(age(c.createdAt))}</dd></dl>
${loopback ? '<p class="warn">Loopback : l\'autorisation part vers une application de cet ordinateur. N\'acceptez que si vous venez de la lancer.</p>' : ''}
<form method="post" action="/consent">${hidden(q)}
${choice}
<p class="note">L'agent ouvre des pages sur les domaines autorisés, clique, tape et se connecte avec les identifiants enregistrés sans jamais voir les mots de passe. Il prend un bail de 10 min prolongé à chaque action. Révocable à tout moment dans la console admin, page Accès agents.</p>
<div class="row"><button class="alt" name="accept" value="false">Refuser</button><button name="accept" value="true">Autoriser</button></div></form>`);
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
        if (r.status === 429) return count('arb_auth_failures_total', { kind: 'rate_limited' }), loginForm(res, oq, 'Trop d\'essais : patientez une minute.'), true;
        if (!r.ok) count('arb_auth_failures_total', { kind: 'password' });
        // No twoFactorRedirect = TOTP not enrolled: refuse (its session cookie is not passed on).
        if (!r.ok || !j.twoFactorRedirect) return loginForm(res, oq, r.ok ? '2FA non activée : lancez `arb admin reset-2fa`.' : 'E-mail ou mot de passe incorrect.'), true;
        return totpForm(res, oq, undefined, r.headers.getSetCookie()), true;
      }
      const r = await callAuth(auth, base, req, `/api/auth/two-factor/${b.code ? 'verify-totp' : 'verify-backup-code'}`, { code: b.code || b.backupCode, oauth_query: oq });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) count('arb_auth_failures_total', { kind: r.status === 429 ? 'rate_limited' : 'totp' });
      if (!r.ok) return totpForm(res, oq, r.status === 429 ? 'Trop d\'essais : patientez une minute.' : 'Code invalide ou expiré. Reconnectez-vous si cela se répète.'), true;
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
