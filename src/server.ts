// agent-remote-browser gateway: remote MCP (Streamable HTTP) -> one sandboxed browser computer per profile.
// Run: node src/server.ts   (config from env, see config.ts)
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type Config } from './config.ts';
import { parseProfileId } from './policy.ts';
import { openStore, type Store } from './store/state.ts';
import { createOAuth } from './oauth/routes.ts';
import { createAudit, log, type Audit } from './audit.ts';
import { createLeases, type Leases } from './mcp/leases.ts';
import { buildServer } from './mcp/tools.ts';
import { createAdmin } from './admin/routes.ts';
import { createComputers, type Computers } from './computers.ts';
import { readJson, send } from './http.ts';
import { DockerDriver } from './host/docker.ts';
import type { HostDriver } from './host/driver.ts';

export interface Ctx { cfg: Config; store: Store; audit: Audit; leases: Leases; computers: Computers; driver: HostDriver }

const DRAIN_MS = 8_000;
const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(Error('timeout')), ms).unref())]);

const listen = (server: http.Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve()));

export async function start(cfg: Config, driver: HostDriver) {
  const store = openStore(cfg.stateFile, cfg.loginKeyFile);
  const audit = createAudit(cfg.auditFile);
  const leases = createLeases();
  const computers = createComputers(driver, store, { egressDir: cfg.egressDir, idleMs: cfg.idleMs });
  const ctx: Ctx = { cfg, store, audit, leases, computers, driver };
  const { handle: oauth, wwwAuthenticate } = createOAuth(store, cfg.publicUrl);

  // Reconnect running computers to their egress proxy (ensure also recreates any with a stale spec).
  for (const c of await driver.list()) {
    const id = parseProfileId(c.id);
    if (c.running && id && store.profile(id)) await computers.serial(id, () => computers.ensure(id));
  }

  const opts = { requestTimeout: 30_000, headersTimeout: 10_000 };
  const mcp = http.createServer(opts, async (req, res) => {
    try {
      // Probes: unauthenticated, no details.
      if (req.url === '/healthz') return res.end('ok');
      if (req.url === '/readyz') {
        const ok = await timeout(driver.list(), 2_000).then(() => true, () => false);
        return res.writeHead(ok ? 200 : 503).end(ok ? 'ready' : 'not ready');
      }
      if (await oauth(req, res, { audit: audit as (e: object) => void })) return;
      if (req.url!.split('?')[0] !== '/mcp') return send(res, 404, { error: 'not found' });
      const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
      const principal = store.principalFor(key);
      // The header tells MCP clients where to start OAuth (protected resource metadata -> DCR -> authorize).
      if (!principal) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': wwwAuthenticate(req) });
      // Stateless MCP: no SSE stream, no session; the browser state lives in the computer.
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const body = await readJson(req);
      const server = buildServer(principal, ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) send(res, 400, { error: 'Invalid request' });
    }
  });

  const admin = createAdmin(ctx);
  const adminServer = http.createServer(opts, admin.handle).on('upgrade', admin.upgrade);

  await listen(mcp, cfg.port, cfg.bindAddr);
  log('info', 'mcp listening', { port: (mcp.address() as { port: number }).port });
  await listen(adminServer, cfg.adminPort, cfg.bindAddr);
  log('info', 'admin UI listening', { port: (adminServer.address() as { port: number }).port });

  const reaper = setInterval(() => computers.reap(), 30_000).unref();

  return {
    mcp, admin: adminServer,
    /** Graceful stop: no new connections, drain in-flight requests, close egress proxies. Computers keep running. */
    async close() {
      clearInterval(reaper);
      const drained = Promise.all([mcp, adminServer].map((s) => new Promise((r) => s.close(r))));
      for (const s of [mcp, adminServer]) s.closeIdleConnections();
      // ponytail: fixed drain budget; a tool call slower than this is cut (the agent retries).
      await timeout(drained, DRAIN_MS).catch(() => log('warn', 'drain timeout'));
      for (const s of [mcp, adminServer]) s.closeAllConnections();
      computers.closeProxies();
    },
  };
}

if (import.meta.main) {
  let cfg: Config;
  try { cfg = loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); }
  const driver = new DockerDriver({ socket: cfg.dockerSocket, prefix: cfg.prefix, image: cfg.image, runtime: cfg.runtime });
  const app = await start(cfg, driver);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, async () => {
    log('info', 'shutting down');
    await app.close();
    process.exit(0);
  });
}
