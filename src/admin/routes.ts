// Admin UI: list computers, live view, human takeover, connected clients. Own port, bound to localhost by compose;
// also on the public listener when ADMIN_PUBLIC=1 (then optionally behind Cloudflare Access).
// Every API call and the live view need the admin's Better Auth session (password + TOTP). Host + Origin are
// checked on top (DNS rebinding, CSRF, cross-site WebSocket).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { urlAllowed, localRequest, validId, cleanAllow, sitesOf, parseProfileId, type ProfileId } from '../policy.ts';
import type { Profile } from '../store/store.ts';
import { readJson, send } from '../http.ts';
import { requireAdmin } from '../auth/guards.ts';
import { callAuth, reply } from '../auth/routes.ts';
import { count } from '../metrics.ts';
import { log, errCode } from '../audit.ts';
import { createAccessVerifier } from '../auth/access-jwt.ts';
import { SESSION, SELECTION } from '../runner/protocol.ts';
import { fillLogin, WrongOrigin } from '../mcp/tools.ts';
import type { Ctx } from '../server.ts';

const ACTIONS = 'start|stop|open|paste|copy|config|login-save|login-test|login-fill|login-delete|release|extend|delete|handoff-take|handoff-done|handoff-fail';
// Better Auth endpoints the admin page calls itself (everything else under /api/auth stays unreachable here).
const VERIFY = { code: '/api/auth/two-factor/verify-totp', backupCode: '/api/auth/two-factor/verify-backup-code' };
const FAILURE: Record<string, string> = { '/api/auth/sign-in/email': 'password', [VERIFY.code]: 'totp', [VERIFY.backupCode]: 'totp' };
const AUTH_API = new Set(['/api/auth/sign-in/email', VERIFY.code, VERIFY.backupCode, '/api/auth/sign-out', '/api/auth/get-session']);
// Step-up: these need a second factor proven in the last 15 minutes (sign-in TOTP counts, a trusted device does not).
const STEP_UP_MS = 15 * 60_000, STEP_UP_FAILS = 5;
const SENSITIVE = new Set(['config', 'login-save', 'login-delete', 'delete']);
const html = new URL('./admin.html', import.meta.url).pathname;
const KEY_DAYS: Record<string, number> = { '30d': 30, '90d': 90, '1y': 365 };
/** API key lifetime in seconds: 30d / 90d / 1y, or an ISO date 1 to 365 days ahead (the api-key plugin's bounds).
 *  Null = refused: every new key expires. */
function keyTtl(expiresIn: unknown, expiresAt: unknown) {
  if (typeof expiresIn === 'string' && Object.hasOwn(KEY_DAYS, expiresIn)) return KEY_DAYS[expiresIn] * 86400;
  const s = typeof expiresAt === 'string' ? Math.floor((Date.parse(expiresAt) - Date.now()) / 1000) : NaN;
  return s >= 86400 && s <= 365 * 86400 ? s : null;
}

export function createAdmin({ cfg, db, store, auth: pubAuth, adminAuth, audit, leases, handoffs, computers: pc, driver }: Ctx) {
  const { profile, decryptLogin } = store;
  // A human may drive a leased browser only while handling the agent's request (paste, saved-login fill, live input).
  const driving = (id: string) => !leases.of(id) || handoffs.open(id)?.state === 'taken';
  const pubUrl = new URL(cfg.publicUrl);
  // Public listener: the https instance. Admin port: the http one (server.ts), so its cookies work on localhost.
  const authOf = (pub: boolean) => pub ? pubAuth : adminAuth;
  const baseOf = (pub: boolean) => pub ? cfg.publicUrl : `http://localhost:${cfg.adminPort}`;
  const access = cfg.access && createAccessVerifier(cfg.access);
  // Admin port: localhost Host/Origin. Public listener: only with ADMIN_PUBLIC, public Host/Origin.
  const allowed = (req: IncomingMessage, pub: boolean) => pub
    ? cfg.adminPublic && req.headers.host === pubUrl.host && (req.headers.origin === undefined || req.headers.origin === pubUrl.origin)
    : localRequest(req.headers, cfg.adminPort);

  /** False = refused. Else the Cloudflare Access email when the request needs one (public listener + ACCESS_*). */
  async function reach(req: IncomingMessage, pub: boolean) {
    if (!allowed(req, pub)) return false;
    return pub && access ? (await access(req.headers['cf-access-jwt-assertion'])) ?? false : undefined;
  }
  /** The admin session; null = sign in first, false = refused (Host/Origin). Behind Access, the Access identity
   *  must be the admin's own email. */
  async function gate(req: IncomingMessage, pub: boolean) {
    const email = await reach(req, pub);
    if (email === false) return false;
    const s = await requireAdmin(authOf(pub), req.headers);
    return s && (email === undefined || s.user.email.toLowerCase() === email) ? s : null;
  }

  // Keys created before expiry became mandatory (Lot 7b) keep working; noExpiry flags them for rotation.
  const listKeys = () => (db.prepare(`SELECT id, name, start, json_extract(metadata, '$.scope') scope, createdAt, lastRequest, lastIp, expiresAt
    FROM apikey ORDER BY createdAt DESC`).all() as { expiresAt: string | null }[]).map((k) => ({ ...k, noExpiry: k.expiresAt === null }));
  const listClients = () => (db.prepare(`SELECT c.clientId id, c.name, c.createdAt,
    (SELECT group_concat(DISTINCT referenceId) FROM oauthConsent WHERE clientId = c.clientId) scopes,
    (SELECT max(createdAt) FROM oauthAccessToken WHERE clientId = c.clientId) lastToken
    FROM oauthClient c ORDER BY c.createdAt DESC`).all());

  const stepUpLeft = (sid: string) => {
    const r = db.prepare('SELECT verified_at v FROM step_up WHERE session_id = ?').get(sid) as { v: number } | undefined;
    return Math.max(0, Math.ceil(((r?.v ?? 0) + STEP_UP_MS - Date.now()) / 1000));
  };
  /** After a TOTP / backup code check: success marks the session it created or confirmed; a failure on a signed-in
   *  session counts, and the 5th one signs it out (Better Auth's lockout only covers the sign-in step). */
  async function settle(r: Response, sid: string | undefined) {
    if (r.ok) {
      const { token } = await r.clone().json().catch(() => ({}));
      const s = db.prepare('SELECT id FROM session WHERE token = ?').get(String(token)) as { id: string } | undefined;
      if (s) db.prepare(`INSERT INTO step_up (session_id, verified_at) VALUES (?, ?)
        ON CONFLICT DO UPDATE SET verified_at = excluded.verified_at, fails = 0`).run(s.id, Date.now());
      return;
    }
    if (!sid || r.status !== 401) return;
    const { fails } = db.prepare(`INSERT INTO step_up (session_id, verified_at, fails) VALUES (?, 0, 1)
      ON CONFLICT DO UPDATE SET fails = fails + 1 RETURNING fails`).get(sid) as { fails: number };
    if (fails >= STEP_UP_FAILS) db.prepare('DELETE FROM session WHERE id = ?').run(sid);
  }

  async function listComputers() {
    const running = new Map((await driver.list()).map((c) => [c.id, c]));
    const log = audit.read();
    return store.profiles().map((p) => {
      const id = p.id;
      const c = running.get(id), last = log.findLast((l) => l.agent === id), l = leases.of(id), h = handoffs.open(id);
      return {
        id, container: `${cfg.prefix}-${id}`,
        state: c ? (c.running ? 'running' : 'exited') : 'none',
        status: c ? (c.running ? 'running' : 'exited') : 'never started',
        // ponytail: volume presence inferred from the container; a volume orphaned by hand shows as missing.
        profile: !!c, allow: p.allow, logins: sitesOf(p),
        leasedUntil: l ? new Date(l.exp).toISOString() : null,
        lastCall: last ? { ts: last.ts, tool: last.tool, ok: last.ok } : null,
        idleStopInS: pc.idleStopInS(id), viewers: pc.viewers(id),
        handoff: h && { id: h.id, state: h.state, reason: h.reason, created: new Date(h.created).toISOString(), deadline: new Date(h.deadline).toISOString() },
      };
    });
  }

  async function computerDetails(id: ProfileId, p: Profile) {
    const running = (await driver.list()).some((c) => c.id === id && c.running);
    // ponytail: a stopped computer shows no cookies; read its volume with a throwaway container if that matters.
    const raw = running ? (await driver.exec(id, ['cat', SESSION], { timeoutMs: 10_000 }).catch(() => null))?.stdout : '';
    let session: { cookies: Record<string, unknown>[]; origins?: { origin: string; localStorage?: unknown[] }[] } = { cookies: [], origins: [] };
    try { session = JSON.parse(raw || ''); } catch {}
    const page = running ? await Promise.all([pc.exec(id, ['get', 'url']), pc.exec(id, ['get', 'title'])])
      .then(([u, t]) => ({ url: u.url, title: t.title }), () => null) : null;
    return {
      id, running, page,
      // Values never leave the gateway: names and metadata only. Same for login passwords.
      logins: Object.entries(p.logins || {}).map(([site, c]) => ({ site, url: c.url, username: c.username,
        lastTestedAt: c.lastTestedAt ? new Date(c.lastTestedAt).toISOString() : null, lastResult: c.lastResult ?? null })),
      cookies: session.cookies.map(({ value, ...c }) => c),
      storage: (session.origins || []).map((o) => ({ origin: o.origin, localStorageKeys: (o.localStorage || []).length })),
      audit: audit.read().filter((l) => l.agent === id).slice(-20).reverse().map(({ ts, tool, ok, ms, via }) => ({ ts, tool, ok, ms, via })),
    };
  }

  async function deleteProfile(id: ProfileId) {
    await pc.remove(id).catch(() => {});
    store.deleteProfile(id); // cascades to its logins, leases, OAuth grants and API keys
  }

  async function handle(req: IncomingMessage, res: ServerResponse, pub: boolean) {
    try {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('x-content-type-options', 'nosniff');
      const path = req.url!.split('?')[0], post = req.method === 'POST';
      if (post && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
        return send(res, 415, { error: 'JSON content type required' });
      if (path === '/' || AUTH_API.has(path)) {
        if (await reach(req, pub) === false) return send(res, 403, { error: 'forbidden' });
        if (path !== '/') {
          const verify = FAILURE[path] === 'totp', s = verify ? await requireAdmin(authOf(pub), req.headers) : null;
          // Trusted devices are an admin-port convenience: never issued on the public listener (nor read there: server.ts).
          const body = pub && post ? { ...(await readJson(req)), trustDevice: false } : undefined;
          const r = await callAuth(authOf(pub), baseOf(pub), req, path, body), kind = FAILURE[path];
          if (kind && (r.status === 401 || r.status === 429)) count('arb_auth_failures_total', { kind: r.status === 429 ? 'rate_limited' : kind });
          if (verify) await settle(r, s?.session.id);
          return await reply(res, r);
        }
        const nonce = randomBytes(18).toString('base64'), ws = `${pub && pubUrl.protocol === 'https:' ? 'wss' : 'ws'}://${req.headers.host}`;
        res.setHeader('content-security-policy', `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' ${ws}`);
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(html, 'utf8').replace('<script>', `<script nonce="${nonce}">`));
      }
      const session = await gate(req, pub);
      if (session === false) return send(res, 403, { error: 'forbidden' });
      if (!session) return send(res, 401, { error: 'Sign in first' });
      const sid = session.session.id;
      if (path === '/api/session') return send(res, 200, { email: session.user.email, stepUpRemainingS: stepUpLeft(sid) });
      if (path === '/api/step-up' && post) {
        const b = (await readJson(req)) || {}, field = typeof b.code === 'string' ? 'code' : typeof b.backupCode === 'string' ? 'backupCode' : null;
        if (!field) return send(res, 400, { error: 'code (TOTP) or backupCode required' });
        req.headers.origin = new URL(baseOf(pub)).origin; // gate() checked it (or its absence): Better Auth wants one
        const r = await callAuth(authOf(pub), baseOf(pub), req, VERIFY[field], { code: b[field] });
        await settle(r, sid);
        if (r.ok) return send(res, 200, { stepUpRemainingS: stepUpLeft(sid) });
        count('arb_auth_failures_total', { kind: r.status === 429 ? 'rate_limited' : 'totp' });
        if (r.status === 429) return send(res, 429, { error: 'Too many attempts, wait a minute' });
        return send(res, 401, await requireAdmin(authOf(pub), req.headers) ? { stepUp: true, error: 'Invalid code' } : { error: 'Sign in first' });
      }
      const stale = () => stepUpLeft(sid) === 0 && (send(res, 401, { stepUp: true, error: 'Confirm with a 2FA code first' }), true);
      if (path === '/api/computers') return send(res, 200, await listComputers());
      if (path === '/api/profiles' && post) {
        const { id, allow } = (await readJson(req)) || {}, a = cleanAllow(allow);
        if (!validId(id)) return send(res, 400, { error: 'Invalid id: lowercase letters, digits, dashes, max 40' });
        if (profile(id)) return send(res, 409, { error: 'This profile already exists' });
        if (!a) return send(res, 400, { error: 'Invalid allow list: plain domains like example.com' });
        store.createProfile(id, a);
        audit({ agent: id, tool: 'admin:create', ok: true });
        return send(res, 201, { id });
      }
      // Connected clients: OAuth clients (with the scopes granted) and API keys. A key is shown once, at creation.
      if (path === '/api/clients' && !post) return send(res, 200, { oauth: listClients(), keys: listKeys() });
      if (path === '/api/keys' && post) {
        if (stale()) return;
        const { name, scope, expiresIn, expiresAt } = (await readJson(req)) || {};
        if (typeof name !== 'string' || !/^[\w .-]{1,60}$/.test(name)) return send(res, 400, { error: 'Name: letters, digits, spaces, dots, dashes (max 60)' });
        const pid = typeof scope === 'string' && scope.startsWith('profile:') ? parseProfileId(scope.slice(8)) : null;
        if (scope !== 'global' && !(pid && profile(pid))) return send(res, 400, { error: 'Scope: global or an existing profile' });
        const ttl = keyTtl(expiresIn, expiresAt);
        if (!ttl) return send(res, 400, { error: 'Expiry required: expiresIn 30d, 90d or 1y, or expiresAt 1 to 365 days ahead' });
        const k = await pubAuth.api.createApiKey({ body: { name, userId: session.user.id, metadata: { scope }, expiresIn: ttl } });
        audit({ agent: pid ?? 'global', tool: 'admin:api-key', ok: true });
        return send(res, 201, { id: k.id, key: k.key, expiresAt: new Date(k.expiresAt!).toISOString() });
      }
      const rv = path.match(/^\/api\/(keys|clients)\/([^/]+)\/revoke$/);
      if (rv && post) {
        if (stale()) return;
        const target = decodeURIComponent(rv[2]);
        // Deleting the client cascades to its tokens and consents (foreign keys).
        const n = rv[1] === 'keys' ? db.prepare('DELETE FROM apikey WHERE id = ?').run(target).changes
          : db.prepare('DELETE FROM oauthClient WHERE clientId = ?').run(target).changes;
        if (!n) return send(res, 404, { error: 'not found' });
        audit({ agent: 'admin', tool: `admin:revoke-${rv[1] === 'keys' ? 'key' : 'client'}`, ok: true });
        return send(res, 200, { revoked: target });
      }
      const m = path.match(new RegExp(`^/api/computers/([^/]+)(?:/(${ACTIONS}))?$`));
      const raw = m && decodeURIComponent(m[1]), id = validId(raw) ? raw : null, p = id && profile(id);
      if (!m || !id || !p) return send(res, 404, { error: 'unknown profile' });
      if (!m[2] && req.method === 'GET') return send(res, 200, await computerDetails(id, p));
      if (!m[2] || !post) return send(res, 405, { error: 'method not allowed' });
      if (SENSITIVE.has(m[2]) && stale()) return;
      const act = m[2], body = (await readJson(req)) || {};
      audit({ agent: id, tool: `admin:${act}`, ok: true });

      if (act === 'open') { // same allowlist as the agent's `open` tool
        if (typeof body.url !== 'string' || !urlAllowed(body.url, p.allow)) return send(res, 400, { error: `Domain not allowed. Allowed: ${p.allow.join(', ')}` });
        await pc.serial(id, () => pc.ab(id, ['open', body.url]));
        return send(res, 200, { opened: true });
      }
      // Takeover clipboard: the remote Chrome has its own, so the admin page bridges the local one through these.
      if (act === 'paste') {
        const t = body.text;
        if (typeof t !== 'string' || !t || t.length > 5000) return send(res, 400, { error: 'Text required, 5000 characters max' });
        if (!driving(id)) return send(res, 409, { error: 'Leased by an agent: take over its request or force release' });
        const [, dashes, rest] = t.match(/^(-*)([\s\S]*)$/)!; // a leading dash would read as a flag
        await pc.serial(id, async () => { for (const s of [...dashes, rest]) if (s) await pc.ab(id, ['keyboard', 'inserttext', s]); });
        return send(res, 200, { pasted: true });
      }
      if (act === 'copy') return send(res, 200, { text: String((await pc.serial(id, () => pc.ab(id, ['eval', SELECTION]))).result ?? '') });
      if (act === 'stop') { await pc.serial(id, () => pc.stop(id)); return send(res, 200, { stopped: true }); }
      if (act === 'start') {
        // `stream status` launches Chrome if needed and tells us the in-container stream port.
        const { port } = await pc.serial(id, () => pc.ab(id, ['stream', 'status']));
        return send(res, 200, { started: true, port });
      }
      if (act === 'config') {
        const a = cleanAllow(body.allow);
        if (!a) return send(res, 400, { error: 'Invalid allow list: plain domains like example.com' });
        store.setAllow(id, a);
        // Drop connections established under the previous policy.
        pc.restrict(id);
        await pc.serial(id, () => pc.stop(id));
        return send(res, 200, { allow: a });
      }
      if (act === 'login-save') {
        const { site, url, username, password } = body;
        if (typeof site !== 'string' || !/^[a-z0-9-]{1,40}$/.test(site)) return send(res, 400, { error: 'Site: lowercase letters, digits, dashes' });
        if (typeof url !== 'string' || !url.startsWith('https://') || !urlAllowed(url, p.allow)) return send(res, 400, { error: 'Login URL must be on an allowed domain' });
        if (typeof username !== 'string' || !username || username.length > 200) return send(res, 400, { error: 'Username required' });
        const old = Object.hasOwn(p.logins, site) ? p.logins[site] : null;
        // Empty password on an existing site = keep the saved one (the UI never reads passwords back).
        if (!password && old && old.url !== url) return send(res, 400, { error: 'Enter the password again to change the login URL' });
        const pw = typeof password === 'string' && password ? password : old ? decryptLogin(id, site, old) : null;
        if (!pw || pw.length > 500) return send(res, 400, { error: 'Password required' });
        store.saveLogin(id, site, { url, username }, pw);
        return send(res, 200, { saved: site });
      }
      if (act === 'login-test' || act === 'login-fill') {
        // Same fill path as the agent's `login` tool. Never while an agent holds the profile.
        // login-fill = takeover: fills the page already open, only if it is on the login's origin.
        const c = Object.hasOwn(p.logins, body.site) ? p.logins[body.site] : null;
        if (!c) return send(res, 404, { error: 'unknown site' });
        if (!c.url.startsWith('https://') || !urlAllowed(c.url, p.allow)) return send(res, 400, { error: 'Login URL is outside the allowlist' });
        const here = act === 'login-fill';
        if (here ? !driving(id) : leases.of(id)) return send(res, 409, { error: 'Leased by an agent: release it or wait' });
        // ponytail: "ok" = the fill went through (form found, submitted); whether the site accepted it shows in the URL.
        const r = await pc.serial(id, async () => {
          try { return { ok: true, url: await fillLogin(pc, id, body.site, c, decryptLogin(id, body.site, c), here) }; }
          catch (e) { return { ok: false, ...(here && { reason: e instanceof WrongOrigin ? 'origin' : 'form' }), url: await pc.ab(id, ['get', 'url']).then((u) => u.url as string, () => null) }; }
        });
        if (!here) store.setLoginTest(id, body.site, r.ok);
        return send(res, 200, r);
      }
      if (act === 'login-delete') {
        if (!Object.hasOwn(p.logins, body.site)) return send(res, 404, { error: 'unknown site' });
        store.deleteLogin(id, body.site);
        return send(res, 200, { deleted: body.site });
      }
      if (act === 'release') { leases.drop(id); return send(res, 200, { released: true }); }
      if (act === 'extend') {
        const n = body.minutes;
        if (!Number.isInteger(n) || n < 1 || n > 120) return send(res, 400, { error: 'minutes: 1 to 120' });
        const l = leases.extend(id, n);
        return l ? send(res, 200, { leasedUntil: new Date(l.exp).toISOString() }) : send(res, 404, { error: 'no live lease' });
      }
      if (act.startsWith('handoff-')) {
        const h = handoffs.open(id), note = typeof body.note === 'string' ? body.note.trim() : '';
        if (!h) return send(res, 409, { error: 'No open request from the agent' });
        if (act === 'handoff-take') { handoffs.take(h.id); return send(res, 200, { state: 'taken' }); } // already taken: same
        if (note.length > 1000) return send(res, 400, { error: 'Note: 1000 characters max' });
        if (act === 'handoff-fail' && !note) return send(res, 400, { error: 'Tell the agent what went wrong' });
        const r = handoffs.finish(h.id, act === 'handoff-done' ? 'done' : 'failed', note || null);
        return r ? send(res, 200, { state: r.state }) : send(res, 409, { error: 'No open request from the agent' });
      }
      if (act === 'delete') { await pc.serial(id, () => deleteProfile(id)); return send(res, 200, { deleted: id }); }
    } catch (e) {
      // Closed fields only (see log): the profile and action from the path, an error code, never the message.
      const m = req.url!.match(/^\/api\/computers\/([^/?]+)(?:\/([a-z-]+))?/), raw = m && decodeURIComponent(m[1]);
      log('error', 'admin operation failed', { profile: validId(raw) ? raw : undefined, tool: m ? `admin:${m[2] || req.method}` : req.url!.split('?')[0].slice(0, 40), code: errCode(e), ok: false });
      if (!res.headersSent) send(res, 500, { error: 'Admin operation failed' });
    }
  }

  // Live view: agent-browser's stream WebSocket listens on 127.0.0.1 inside the computer. The driver relays raw
  // bytes to it (no network between gateway and computers, no WebSocket library).
  async function upgrade(req: IncomingMessage, sock: Duplex, head: Buffer, pub: boolean) {
    const m = req.url!.match(/^\/api\/computers\/([^/?]+)\/stream(\?[\w=&]*)?$/);
    const id = m && validId(m[1]) ? m[1] : null, key = req.headers['sec-websocket-key'];
    if (!m || !id || !profile(id) || !/^[\w+/=]+$/.test(key || '')) return sock.destroy();
    // Browsers send the Origin on WebSocket upgrades: gate() refuses cross-site ones.
    if (!await gate(req, pub).catch(() => null)) return sock.destroy();
    let port: number, relay: Duplex;
    try {
      ({ port } = await pc.exec(id, ['stream', 'status']));
      relay = await driver.stream(id);
    } catch { return sock.destroy(); }
    relay.write(`${+port}\nGET /${m[2] || ''} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    relay.pipe(sock);
    const leave = pc.watch(id);
    audit({ agent: id, tool: 'admin:view', ok: true });
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      leave();
      relay.destroy(); sock.destroy();
    };
    // Client→browser: while an agent holds the lease and no handoff is taken, only acks and control frames pass
    // (no input_mouse / input_keyboard, nor any other command). Checked per frame: taking over unlocks it live.
    const feed = frames();
    const pass = (chunk: Buffer) => {
      const fs = feed(chunk);
      if (!fs) return done();
      for (const f of fs) {
        if (!f.fin || f.op === 0) return done(); // ponytail: no fragmented frames; the admin page never sends any
        if (f.op < 8 && !driving(id) && !(f.op === 1 && isAck(f.data))) continue;
        relay.write(f.raw);
      }
    };
    if (head?.length) pass(head);
    sock.on('data', pass);
    for (const e of [sock, relay]) e.on('error', done).on('close', done);
    relay.on('end', done);
  }

  return { handle, upgrade };
}

const isAck = (b: Buffer) => { try { return JSON.parse(b.toString()).type === 'ack'; } catch { return false; } };

/** Client→server WebSocket frames (RFC 6455, always masked). The feed buffers partial frames and returns the complete
 *  ones, or null on a protocol violation (unmasked, or larger than `max`): close the connection then. */
export function frames(max = 65536) {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out: { raw: Buffer; op: number; fin: boolean; data: Buffer }[] = [];
    for (;;) {
      if (buf.length < 2) return out;
      if (!(buf[1] & 0x80)) return null;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return out; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return out; const n = buf.readBigUInt64BE(2); len = n > BigInt(max) ? Infinity : Number(n); off = 10; }
      if (len > max) return null;
      const end = off + 4 + len;
      if (buf.length < end) return out;
      const data = Buffer.from(buf.subarray(off + 4, end));
      for (let i = 0; i < len; i++) data[i] ^= buf[off + (i & 3)];
      out.push({ raw: buf.subarray(0, end), op: buf[0] & 0x0f, fin: !!(buf[0] & 0x80), data });
      buf = buf.subarray(end);
    }
  };
}
