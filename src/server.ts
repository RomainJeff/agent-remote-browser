// agent-remote-browser gateway: remote MCP (Streamable HTTP) -> one sandboxed browser computer per profile.
// Host access goes through the runner (src/runner/server.ts); this process never holds the Docker socket.
// Run: node src/server.ts   (config from env, see config.ts)
import http from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type Config } from './config.ts';
import { parseProfileId } from './policy.ts';
import { openDb } from './store/db.ts';
import { openStore, type Store } from './store/store.ts';
import { createAuth, authOptions, type Auth } from './auth/better-auth.ts';
import { createAuthRoutes } from './auth/routes.ts';
import { principal, purgeClients } from './auth/guards.ts';
import { createAudit, log, type Audit } from './audit.ts';
import { createLeases, type Leases } from './mcp/leases.ts';
import { buildServer } from './mcp/tools.ts';
import { createAdmin } from './admin/routes.ts';
import { createComputers, type Computers } from './computers.ts';
import { readJson, send } from './http.ts';
import { RunnerDriver } from './host/runner.ts';
import type { HostDriver } from './host/driver.ts';

export interface Ctx { cfg: Config; db: DatabaseSync; store: Store; auth: Auth; audit: Audit; leases: Leases; computers: Computers; driver: HostDriver }

const DRAIN_MS = 8_000;
const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(Error('timeout')), ms).unref())]);

/** Rate limits key on Cf-Connecting-IP (better-auth.ts). Kept only behind the tunnel (TRUST_PROXY=cloudflare), else
 *  overwritten with the socket address: a direct client cannot pick its own IP. */
export function clientIp(req: http.IncomingMessage, trust: boolean) {
  if (!trust || !req.headers['cf-connecting-ip']) req.headers['cf-connecting-ip'] = req.socket.remoteAddress || 'unknown';
}

const listen = (server: http.Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve()));

export async function start(cfg: Config, driver: HostDriver) {
  const db = openDb(join(cfg.dataDir, 'arb.db'));
  let store: Store, a: ReturnType<typeof createAuth>;
  try { store = openStore(db, cfg.loginKeyFile); a = createAuth(db, authOptions(cfg)); } catch (e) { db.close(); throw e; }
  const { auth, pending } = a;
  const audit = createAudit(cfg.auditFile);
  const leases = createLeases(db);
  const computers = createComputers(driver, store, { egressDir: cfg.egressDir, idleMs: cfg.idleMs });
  const ctx: Ctx = { cfg, db, store, auth, audit, leases, computers, driver };
  const authRoutes = createAuthRoutes(db, auth, pending, cfg.publicUrl);
  const admin = createAdmin(ctx);
  // The header tells MCP clients where to start OAuth (protected resource metadata -> DCR -> authorize).
  const challenge = { 'www-authenticate': `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"` };

  // Reconnect running computers to their egress proxy (ensure also recreates any with a stale spec).
  for (const c of await driver.list()) {
    const id = parseProfileId(c.id);
    if (c.running && id && store.profile(id)) await computers.serial(id, () => computers.ensure(id));
  }

  const opts = { requestTimeout: 30_000, headersTimeout: 10_000 };
  const mcp = http.createServer(opts, async (req, res) => {
    clientIp(req, cfg.trustProxy);
    try {
      // Probes: unauthenticated, no details.
      if (req.url === '/healthz') return res.end('ok');
      if (req.url === '/readyz') {
        const ok = await timeout(driver.list(), 2_000).then(() => true, () => false);
        return res.writeHead(ok ? 200 : 503).end(ok ? 'ready' : 'not ready');
      }
      if (await authRoutes.handle(req, res)) return;
      if (req.url!.split('?')[0] !== '/mcp') {
        if (cfg.adminPublic) return admin.handle(req, res, true);
        return send(res, 404, { error: 'not found' });
      }
      const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
      const who = await principal(db, auth, key);
      if (!who) return send(res, 401, { error: 'unauthorized' }, challenge);
      // Stateless MCP: no SSE stream, no session; the browser state lives in the computer.
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const body = await readJson(req);
      const server = buildServer(who, ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) send(res, 400, { error: 'Invalid request' });
    }
  });

  if (cfg.adminPublic) mcp.on('upgrade', (req, sock, head) => admin.upgrade(req, sock, head, true));
  const adminServer = http.createServer(opts, (req, res) => { clientIp(req, false); admin.handle(req, res, false); })
    .on('upgrade', (req, sock, head) => admin.upgrade(req, sock, head, false));

  await listen(mcp, cfg.port, cfg.bindAddr);
  log('info', 'mcp listening', { port: (mcp.address() as { port: number }).port });
  await listen(adminServer, cfg.adminPort, cfg.bindAddr);
  log('info', 'admin UI listening', { port: (adminServer.address() as { port: number }).port });

  const reaper = setInterval(() => computers.reap(), 30_000).unref();
  const purge = setInterval(() => purgeClients(db), 3600_000).unref();

  return {
    mcp, admin: adminServer,
    /** Graceful stop: no new connections, drain in-flight requests, close egress proxies. Computers keep running. */
    async close() {
      clearInterval(reaper); clearInterval(purge);
      const drained = Promise.all([mcp, adminServer].map((s) => new Promise((r) => s.close(r))));
      for (const s of [mcp, adminServer]) s.closeIdleConnections();
      // ponytail: fixed drain budget; a tool call slower than this is cut (the agent retries).
      await timeout(drained, DRAIN_MS).catch(() => log('warn', 'drain timeout'));
      for (const s of [mcp, adminServer]) s.closeAllConnections();
      computers.closeProxies();
      db.close();
    },
  };
}

if (import.meta.main) {
  let cfg: Config;
  try { cfg = loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); }
  const app = await start(cfg, new RunnerDriver(cfg.runnerSocket));
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, async () => {
    log('info', 'shutting down');
    await app.close();
    process.exit(0);
  });
}
