// Admin UI: list computers, live view, human takeover. Separate port, bound to localhost by compose,
// never behind the tunnel. ponytail: no auth beyond "localhost only" (Host + Origin checked against
// DNS rebinding / CSRF / cross-site WebSocket). Lot 4 puts Better Auth in front.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { urlAllowed, localRequest, validId, cleanAllow, sitesOf, hash, type ProfileId } from '../policy.ts';
import { newToken, type Profile } from '../store/store.ts';
import { readJson, send } from '../http.ts';
import type { Ctx } from '../server.ts';

const SESSION = '/home/agent/.agent-browser/sessions/agent-default.json'; // --restore state, saved every 30 s
const ACTIONS = 'start|stop|open|token|config|login-save|login-delete|release|delete';
const html = new URL('./admin.html', import.meta.url).pathname;

export function createAdmin({ cfg, store, audit, leases, computers: pc, driver }: Ctx) {
  const { profile, decryptLogin } = store;
  const localReq = (req: IncomingMessage) => localRequest(req.headers, cfg.adminPort);

  async function listComputers() {
    const running = new Map((await driver.list()).map((c) => [c.id, c]));
    const log = audit.read();
    return store.profiles().map((p) => {
      const id = p.id;
      const c = running.get(id), last = log.findLast((l) => l.agent === id), l = leases.of(id);
      return {
        id, container: `${cfg.prefix}-${id}`,
        state: c ? (c.running ? 'running' : 'exited') : 'none',
        status: c ? (c.running ? 'running' : 'exited') : 'never started',
        // ponytail: volume presence inferred from the container; a volume orphaned by hand shows as missing.
        profile: !!c, allow: p.allow, logins: sitesOf(p), hasToken: !!p.tokenHash,
        leasedUntil: l ? new Date(l.exp).toISOString() : null,
        lastCall: last ? { ts: last.ts, tool: last.tool, ok: last.ok } : null,
        idleStopInS: pc.idleStopInS(id), viewers: pc.viewers(id),
      };
    });
  }

  async function computerDetails(id: ProfileId, p: Profile) {
    const running = (await driver.list()).some((c) => c.id === id && c.running);
    // ponytail: a stopped computer shows no cookies (the POC read its volume with a throwaway container).
    const raw = running ? (await driver.exec(id, ['cat', SESSION], { timeoutMs: 10_000 }).catch(() => null))?.stdout : '';
    let session: { cookies: Record<string, unknown>[]; origins?: { origin: string; localStorage?: unknown[] }[] } = { cookies: [], origins: [] };
    try { session = JSON.parse(raw || ''); } catch {}
    const page = running ? await Promise.all([pc.exec(id, ['get', 'url']), pc.exec(id, ['get', 'title'])])
      .then(([u, t]) => ({ url: u.url, title: t.title }), () => null) : null;
    return {
      id, running, page,
      // Values never leave the gateway: names and metadata only. Same for login passwords.
      logins: Object.entries(p.logins || {}).map(([site, c]) => ({ site, url: c.url, username: c.username })),
      cookies: session.cookies.map(({ value, ...c }) => c),
      storage: (session.origins || []).map((o) => ({ origin: o.origin, localStorageKeys: (o.localStorage || []).length })),
      audit: audit.read().filter((l) => l.agent === id).slice(-20).reverse().map(({ ts, tool, ok, ms, via }) => ({ ts, tool, ok, ms, via })),
    };
  }

  async function deleteProfile(id: ProfileId) {
    await pc.remove(id).catch(() => {});
    store.deleteProfile(id); // cascades to its logins, leases and OAuth tokens
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('x-content-type-options', 'nosniff');
      if (!localReq(req)) return send(res, 403, { error: 'localhost only' });
      const path = req.url!.split('?')[0], post = req.method === 'POST';
      if (post && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
        return send(res, 415, { error: 'JSON content type required' });
      if (path === '/') {
        const nonce = randomBytes(18).toString('base64');
        res.setHeader('content-security-policy', `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' ws://${req.headers.host}`);
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(html, 'utf8').replace('<script>', `<script nonce="${nonce}">`));
      }
      if (path === '/api/computers') return send(res, 200, await listComputers());
      if (path === '/api/settings') return send(res, 200, { globalToken: !!store.globalTokenHash() });
      // Tokens are returned once, here, and stored as hashes. Regenerating one revokes its OAuth tokens.
      if (path === '/api/global-token' && post) {
        const token = newToken('acg');
        store.setGlobalTokenHash(hash(token));
        store.revokeTokens({ global: true });
        audit({ agent: 'global', tool: 'admin:global-token', ok: true });
        return send(res, 200, { token });
      }
      if (path === '/api/profiles' && post) {
        const { id, allow } = (await readJson(req)) || {}, a = cleanAllow(allow);
        if (!validId(id)) return send(res, 400, { error: 'Invalid id: lowercase letters, digits, dashes, max 40' });
        if (profile(id)) return send(res, 409, { error: 'This profile already exists' });
        if (!a) return send(res, 400, { error: 'Invalid allow list: plain domains like example.com' });
        const token = newToken('acp');
        store.createProfile(id, a, hash(token));
        audit({ agent: id, tool: 'admin:create', ok: true });
        return send(res, 201, { id, token });
      }
      const m = path.match(new RegExp(`^/api/computers/([^/]+)(?:/(${ACTIONS}))?$`));
      const raw = m && decodeURIComponent(m[1]), id = validId(raw) ? raw : null, p = id && profile(id);
      if (!m || !id || !p) return send(res, 404, { error: 'unknown profile' });
      if (!m[2] && req.method === 'GET') return send(res, 200, await computerDetails(id, p));
      if (!m[2] || !post) return send(res, 405, { error: 'method not allowed' });
      const act = m[2], body = (await readJson(req)) || {};
      audit({ agent: id, tool: `admin:${act}`, ok: true });

      if (act === 'open') { // same allowlist as the agent's `open` tool
        if (typeof body.url !== 'string' || !urlAllowed(body.url, p.allow)) return send(res, 400, { error: `Domain not allowed. Allowed: ${p.allow.join(', ')}` });
        await pc.serial(id, () => pc.ab(id, ['open', body.url]));
        return send(res, 200, { opened: true });
      }
      if (act === 'stop') { await pc.serial(id, () => pc.stop(id)); return send(res, 200, { stopped: true }); }
      if (act === 'start') {
        // `stream status` launches Chrome if needed and tells us the in-container stream port.
        const { port } = await pc.serial(id, () => pc.ab(id, ['stream', 'status']));
        return send(res, 200, { started: true, port });
      }
      if (act === 'token') {
        const token = newToken('acp');
        store.setProfileToken(id, hash(token));
        store.revokeTokens({ profile: id });
        return send(res, 200, { token });
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
      if (act === 'login-delete') {
        if (!Object.hasOwn(p.logins, body.site)) return send(res, 404, { error: 'unknown site' });
        store.deleteLogin(id, body.site);
        return send(res, 200, { deleted: body.site });
      }
      if (act === 'release') { leases.drop(id); return send(res, 200, { released: true }); }
      if (act === 'delete') { await pc.serial(id, () => deleteProfile(id)); return send(res, 200, { deleted: id }); }
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'Admin operation failed' });
    }
  }

  // Live view: agent-browser's stream WebSocket listens on 127.0.0.1 inside the computer. The driver relays raw
  // bytes to it (no network between gateway and computers, no WebSocket library).
  async function upgrade(req: IncomingMessage, sock: Duplex, head: Buffer) {
    const m = req.url!.match(/^\/api\/computers\/([^/?]+)\/stream(\?[\w=&]*)?$/);
    const id = m && validId(m[1]) ? m[1] : null, key = req.headers['sec-websocket-key'];
    if (!m || !id || !profile(id) || !localReq(req) || !/^[\w+/=]+$/.test(key || '')) return sock.destroy();
    let port: number, relay: Duplex;
    try {
      ({ port } = await pc.exec(id, ['stream', 'status']));
      relay = await driver.stream(id);
    } catch { return sock.destroy(); }
    relay.write(`${+port}\nGET /${m[2] || ''} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    if (head?.length) relay.write(head);
    sock.pipe(relay);
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
    for (const e of [sock, relay]) e.on('error', done).on('close', done);
    relay.on('end', done);
  }

  return { handle, upgrade };
}
