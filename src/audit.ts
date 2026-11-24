// Two outputs, never mixed: the audit file (who did what, kept) and stdout logs (operations, one JSON line each).
// Neither ever receives tool arguments, secrets, tokens or page content.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

export interface AuditEntry { agent: string; by?: string; tool: string; ok: boolean; ms?: number; via?: 'global'; steps?: number; failed_at?: number }
export type Audit = ReturnType<typeof createAudit>;

export function createAudit(file: string) {
  // Persist only fields chosen by the gateway: callers may pass more (e.g. OAuth args), they are dropped here.
  const write = ({ agent, by, tool, ok, ms, via, steps, failed_at }: AuditEntry) =>
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), agent, by, tool, ok, ms, via, steps, failed_at }) + '\n', { mode: 0o600 });
  // ponytail: reads the whole file; tail it when it grows past a few MB.
  const read = (): (AuditEntry & { ts: string })[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return Object.assign(write, { read });
}

export interface LogFields { profile?: string; tool?: string; ms?: number; ok?: boolean; port?: number; code?: string }

/** An error's code, never its message: errno (ENOENT), Chrome net error (ERR_PROXY_CONNECTION_FAILED) or timeout. */
export const errCode = (e: unknown) => String((e as Error)?.message ?? '').match(/\b(?:ERR_[A-Z_]+|E[A-Z]{3,}|timeout|Timeout)\b/)?.[0];

/** One JSON line on stdout. Fields are a closed list: nothing free-form (URLs, errors, args) can leak in. */
export function log(level: 'info' | 'warn' | 'error', msg: string, f: LogFields = {}) {
  const { profile, tool, ms, ok, port, code } = f;
  process.stdout.write(JSON.stringify({ level, msg, profile, tool, ms, ok, port, code }) + '\n');
}
