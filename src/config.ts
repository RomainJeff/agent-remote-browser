// Every environment variable the gateway and the runner read, validated once at startup. Invalid config = the process exits.
import { z } from 'zod';

const root = (f: string) => new URL('../' + f, import.meta.url).pathname;
const port = (d: number) => z.coerce.number().int().min(1).max(65535).default(d);
const flag = z.enum(['', '0', '1']).default('').transform((v) => v === '1');
/** Prefix of every Docker resource (containers, volumes, label), so two stacks can share one daemon. */
const prefix = z.string().regex(/^[a-z0-9][a-z0-9-]{0,19}$/).default('arb');
/** The runner's RPC socket, on a volume shared by the gateway and the runner only. */
const runnerSocket = z.string().min(1).default('/run/arb-runner/runner.sock');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  /** Interface both listeners bind to. Compose sets 0.0.0.0 inside the container and publishes on 127.0.0.1. */
  BIND_ADDR: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
  /** MCP + OAuth listener. */
  PORT: port(8787),
  /** Admin UI listener. Host must be localhost:ADMIN_PORT, so publish it on the same port number. */
  ADMIN_PORT: port(8788),
  /** Public base URL, without trailing slash: MCP resource, OAuth issuer (${PUBLIC_URL}/api/auth), Better Auth baseURL.
   *  Empty = http://localhost:${PORT} (dev only). */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/$/, '')).optional(),
  /** Holds arb.db (SQLite: profiles, encrypted logins, leases, Better Auth: admin, sessions, OAuth, API keys). */
  DATA_DIR: z.string().min(1).default(root('data')),
  /** 32-byte AES key for saved logins (a Docker secret in compose). Created on first start only if writable. Keep it out of backups of DATA_DIR. */
  LOGIN_KEY_FILE: z.string().min(1).default('/run/secrets/login_key'),
  /** Better Auth secret (signs cookies, encrypts TOTP secrets), 32+ characters. Prefer the file (a Docker secret in compose). */
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_SECRET_FILE: z.string().min(1).default('/run/secrets/better_auth_secret'),
  /** 1 = the admin UI is also served on the public listener (behind PUBLIC_URL). Default: admin port, localhost only. */
  ADMIN_PUBLIC: flag,
  /** Cloudflare Access in front of the public admin: application AUD tag and team name (<team>.cloudflareaccess.com).
   *  Required with ADMIN_PUBLIC=1. */
  ACCESS_AUD: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  ACCESS_TEAM: z.string().regex(/^[a-z0-9-]{1,63}$/).optional(),
  /** cloudflare = the client IP comes from Cf-Connecting-IP (set it only when the listener is reachable through the
   *  tunnel alone: compose.tunnel.yaml). Empty = the socket address; client IP headers are ignored. */
  TRUST_PROXY: z.enum(['', 'cloudflare']).default(''),
  /** Append-only JSON lines: who called which tool, when, ok or not. Never arguments. */
  AUDIT_FILE: z.string().min(1).default(root('audit.jsonl')),
  /** If this file exists, every tool call is refused. */
  KILL_FILE: z.string().min(1).default(root('KILL')),
  /** Idle minutes before a browser container is stopped. */
  IDLE_MIN: z.coerce.number().positive().default(5),
  ARB_PREFIX: prefix,
  /** Gateway side of the ${ARB_PREFIX}-egress volume: one proxy socket per profile. */
  EGRESS_DIR: z.string().min(1).default('/run/arb-egress'),
  RUNNER_SOCKET: runnerSocket,
}).superRefine((c, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (c.NODE_ENV === 'production') {
    if (!c.PUBLIC_URL) issue('PUBLIC_URL is required in production');
    else if (/\.trycloudflare\.com$/i.test(new URL(c.PUBLIC_URL).hostname)) issue('Quick tunnels are refused in production');
  }
  if (c.PORT === c.ADMIN_PORT) issue('PORT and ADMIN_PORT must differ');
  if (!c.ACCESS_AUD !== !c.ACCESS_TEAM) issue('Set both ACCESS_AUD and ACCESS_TEAM, or neither');
  if (c.ADMIN_PUBLIC && !c.PUBLIC_URL) issue('ADMIN_PUBLIC=1 requires PUBLIC_URL');
  if (c.ADMIN_PUBLIC && !c.ACCESS_AUD) issue('ADMIN_PUBLIC=1 requires Cloudflare Access (ACCESS_AUD and ACCESS_TEAM)');
});

/** The runner: the only process with the Docker socket. */
const runnerSchema = z.object({
  ARB_PREFIX: prefix,
  /** Browser image, the only one the runner starts computers from. Default: ${ARB_PREFIX}-computer:dev. */
  IMAGE: z.string().min(1).optional(),
  /** Docker Engine API socket. */
  DOCKER_SOCKET: z.string().min(1).default('/var/run/docker.sock'),
  /** Container runtime for the browsers. Must be runsc (gVisor) unless ALLOW_NO_SANDBOX=1. */
  SANDBOX_RUNTIME: z.string().optional(),
  /** 1 = accept the Docker default runtime (dev on macOS, CI). */
  ALLOW_NO_SANDBOX: flag,
  /** 1 = accept copyVolume (migrate-from-poc --apply). Set for the migration only: it lets the gateway read POC profiles. */
  ALLOW_POC_MIGRATION: flag,
  RUNNER_SOCKET: runnerSocket,
}).refine((c) => c.SANDBOX_RUNTIME === 'runsc' || c.ALLOW_NO_SANDBOX, 'SANDBOX_RUNTIME=runsc is required (or ALLOW_NO_SANDBOX=1)');

/** Empty strings count as unset (compose passes `${VAR:-}`). Throws one readable error listing every problem. */
function parse<T extends z.ZodType>(s: T, env: NodeJS.ProcessEnv): z.output<T> {
  const r = s.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  if (!r.success) throw Error('Invalid configuration:\n' + r.error.issues.map((i) => `- ${i.path.join('.') || 'env'}: ${i.message}`).join('\n'));
  return r.data;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = parse(schema, env);
  return {
    production: c.NODE_ENV === 'production',
    bindAddr: c.BIND_ADDR, port: c.PORT, adminPort: c.ADMIN_PORT, publicUrl: (c.PUBLIC_URL ?? `http://localhost:${c.PORT}`).replace(/\/$/, ''),
    authSecret: c.BETTER_AUTH_SECRET, authSecretFile: c.BETTER_AUTH_SECRET_FILE, adminPublic: c.ADMIN_PUBLIC,
    access: c.ACCESS_AUD && c.ACCESS_TEAM ? { aud: c.ACCESS_AUD, team: c.ACCESS_TEAM } : null, trustProxy: c.TRUST_PROXY === 'cloudflare',
    dataDir: c.DATA_DIR, loginKeyFile: c.LOGIN_KEY_FILE, auditFile: c.AUDIT_FILE, killFile: c.KILL_FILE,
    idleMs: c.IDLE_MIN * 60_000, prefix: c.ARB_PREFIX, egressDir: c.EGRESS_DIR, runnerSocket: c.RUNNER_SOCKET,
  };
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = parse(runnerSchema, env);
  return { prefix: c.ARB_PREFIX, image: c.IMAGE ?? `${c.ARB_PREFIX}-computer:dev`, dockerSocket: c.DOCKER_SOCKET,
    runtime: c.SANDBOX_RUNTIME, socket: c.RUNNER_SOCKET, migration: !!c.ALLOW_POC_MIGRATION };
}
