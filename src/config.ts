// Every environment variable the gateway reads, validated once at startup. Invalid config = the process exits.
import { z } from 'zod';

const root = (f: string) => new URL('../' + f, import.meta.url).pathname;
const port = (d: number) => z.coerce.number().int().min(1).max(65535).default(d);
const flag = z.enum(['', '0', '1']).default('').transform((v) => v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  /** Interface both listeners bind to. Compose sets 0.0.0.0 inside the container and publishes on 127.0.0.1. */
  BIND_ADDR: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
  /** MCP + OAuth listener. */
  PORT: port(8787),
  /** Admin UI listener. Host must be localhost:ADMIN_PORT, so publish it on the same port number. */
  ADMIN_PORT: port(8788),
  /** OAuth issuer and public base URL, without trailing slash. Empty = derived from the Host header (dev only). */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/$/, '')).optional(),
  /** Holds arb.db (SQLite: profiles, token hashes, encrypted logins, leases, OAuth clients and tokens). */
  DATA_DIR: z.string().min(1).default(root('data')),
  /** 32-byte AES key for saved logins (a Docker secret in compose). Created on first start only if writable. Keep it out of backups of DATA_DIR. */
  LOGIN_KEY_FILE: z.string().min(1).default('/run/secrets/login_key'),
  /** Append-only JSON lines: who called which tool, when, ok or not. Never arguments. */
  AUDIT_FILE: z.string().min(1).default(root('audit.jsonl')),
  /** If this file exists, every tool call is refused. */
  KILL_FILE: z.string().min(1).default(root('KILL')),
  /** Idle minutes before a browser container is stopped. */
  IDLE_MIN: z.coerce.number().positive().default(5),
  /** Prefix of every Docker resource (containers, volumes, label), so two stacks can share one daemon. */
  ARB_PREFIX: z.string().regex(/^[a-z0-9][a-z0-9-]{0,19}$/).default('arb'),
  /** Browser image. Default: ${ARB_PREFIX}-computer:dev. */
  IMAGE: z.string().min(1).optional(),
  /** Gateway side of the ${ARB_PREFIX}-egress volume: one proxy socket per profile. */
  EGRESS_DIR: z.string().min(1).default('/run/arb-egress'),
  /** Docker Engine API socket. */
  DOCKER_SOCKET: z.string().min(1).default('/var/run/docker.sock'),
  /** Container runtime for the browsers. Must be runsc (gVisor) unless ALLOW_NO_SANDBOX=1. */
  SANDBOX_RUNTIME: z.string().optional(),
  /** 1 = accept the Docker default runtime (dev on macOS, CI). */
  ALLOW_NO_SANDBOX: flag,
}).superRefine((c, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (c.SANDBOX_RUNTIME !== 'runsc' && !c.ALLOW_NO_SANDBOX) issue('SANDBOX_RUNTIME=runsc is required (or ALLOW_NO_SANDBOX=1)');
  if (c.NODE_ENV === 'production') {
    if (!c.PUBLIC_URL) issue('PUBLIC_URL is required in production');
    else if (/\.trycloudflare\.com$/i.test(new URL(c.PUBLIC_URL).hostname)) issue('Quick tunnels are refused in production');
  }
  if (c.PORT === c.ADMIN_PORT) issue('PORT and ADMIN_PORT must differ');
});

export type Config = ReturnType<typeof loadConfig>;

/** Empty strings count as unset (compose passes `${VAR:-}`). Throws one readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const r = schema.safeParse(set);
  if (!r.success) throw Error('Invalid configuration:\n' + r.error.issues.map((i) => `- ${i.path.join('.') || 'env'}: ${i.message}`).join('\n'));
  const c = r.data;
  return {
    production: c.NODE_ENV === 'production',
    bindAddr: c.BIND_ADDR, port: c.PORT, adminPort: c.ADMIN_PORT, publicUrl: c.PUBLIC_URL,
    dataDir: c.DATA_DIR, loginKeyFile: c.LOGIN_KEY_FILE, auditFile: c.AUDIT_FILE, killFile: c.KILL_FILE,
    idleMs: c.IDLE_MIN * 60_000, prefix: c.ARB_PREFIX, image: c.IMAGE ?? `${c.ARB_PREFIX}-computer:dev`,
    egressDir: c.EGRESS_DIR, dockerSocket: c.DOCKER_SOCKET, runtime: c.SANDBOX_RUNTIME,
  };
}
