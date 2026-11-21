// Pure policy helpers (no I/O) — tested by check.mjs.
import { createHash } from 'node:crypto';

/** Tokens are stored as sha256 hex, never in clear. Lookup by hash: no timing oracle on a 256-bit random secret. */
export const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

/** http(s) only, host must equal an allowed domain or be a subdomain of it. */
export function urlAllowed(raw, allow) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || u.port || !validDomain(host)) return false;
  return allow.some((d) => host === d || host.endsWith('.' + d));
}

/** Container/volume-safe name. */
export const slug = (id) => String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);

/** Profile ids are already slugs, so two profiles can never share a container or volume. */
export const validId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
export const validDomain = (d) => typeof d === 'string' && !/(^|\.)(localhost|internal|local|lan|home\.arpa)$/.test(d) && /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d);

/** OAuth redirect URIs: https anywhere, http only to loopback (native clients). No fragment. */
export function redirectUriOk(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('#') || u.username || u.password || /[\\\s]/.test(raw)) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
}

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export const pkceOk = (verifier, challenge) =>
  typeof verifier === 'string' && /^[\w.~-]{43,128}$/.test(verifier) &&
  createHash('sha256').update(verifier).digest('base64url') === challenge;

export function localRequest(headers,port) {
  const host = headers.host;
  return ['localhost','127.0.0.1','[::1]'].some(h=>host === h+':'+port) &&
    (headers.origin === undefined || headers.origin === 'http://'+host) &&
    [undefined,'same-origin','none'].includes(headers['sec-fetch-site']);
}

// A fixed-size counter independent of spoofable forwarding headers.
export function windowBudget(limit, duration) {
  let until = 0, used = 0;
  return (now = Date.now()) => {
    if (now >= until) { until = now + duration; used = 0; }
    if (used >= limit) return false;
    used++;
    return true;
  };
}
