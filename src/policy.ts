// Pure policy helpers (no I/O) and the shared identity types — tested by test/unit/policy.test.ts.
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** A validated profile id. Only parseProfileId() makes one, so a driver never receives a raw string. */
export type ProfileId = string & { readonly __brand: 'ProfileId' };
/** Who is calling /mcp: one profile, or global (manage + lease profiles). From the OAuth grant or API key scope. */
export type Principal = { global: true; profile?: never } | { profile: ProfileId; global?: never };

/** Tokens are stored as sha256 hex, never in clear. Lookup by hash: no timing oracle on a 256-bit random secret. */
export const hash = (s: unknown) => createHash('sha256').update(String(s)).digest('hex');

/** http(s) only, host must equal an allowed domain or be a subdomain of it. */
export function urlAllowed(raw: string, allow: readonly string[]) {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || u.port || !validDomain(host)) return false;
  return allow.some((d) => host === d || host.endsWith('.' + d));
}

/** Container/volume-safe name. */
export const slug = (id: unknown) => String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);

/** Profile ids are already slugs, so two profiles can never share a container or volume. */
export const validId = (id: unknown): id is ProfileId => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
export const parseProfileId = (id: unknown): ProfileId | null => (validId(id) ? id : null);
export const validDomain = (d: unknown): d is string => typeof d === 'string' && !/(^|\.)(localhost|internal|local|lan|home\.arpa)$/.test(d) && /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d);

/** Allowlist from user input: lowercased domains, 1 to 50. Returns null when invalid. */
export function cleanAllow(allow: unknown) {
  if (!Array.isArray(allow)) return null;
  const a = [...new Set(allow.map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
  return a.length && a.length <= 50 && a.every(validDomain) ? a : null;
}
export const sitesOf = (p: { logins?: Record<string, unknown> }) => Object.keys(p.logins || {});

export function localRequest(headers: IncomingHttpHeaders, port: number) {
  const host = headers.host;
  return ['localhost','127.0.0.1','[::1]'].some(h=>host === h+':'+port) &&
    (headers.origin === undefined || headers.origin === 'http://'+host) &&
    [undefined,'same-origin','none'].includes(headers['sec-fetch-site'] as string | undefined);
}

// A fixed-size counter independent of spoofable forwarding headers.
export function windowBudget(limit: number, duration: number) {
  let until = 0, used = 0;
  return (now = Date.now()) => {
    if (now >= until) { until = now + duration; used = 0; }
    if (used >= limit) return false;
    used++;
    return true;
  };
}
