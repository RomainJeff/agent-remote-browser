// Cloudflare Access in front of the public admin: verifies the Cf-Access-Jwt-Assertion header (RS256, WebCrypto)
// against the team's JWKS. Extra layer only: the admin still needs its Better Auth session (password + TOTP).
type Jwk = JsonWebKey & { kid?: string };
export interface AccessConfig { aud: string; team: string }

const b64 = (s: string) => Buffer.from(s, 'base64url');
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

/** `fetchKeys` replaces the JWKS download (tests). Returns the verified email, or null. */
export function createAccessVerifier(c: AccessConfig, fetchKeys?: () => Promise<Jwk[]>) {
  const issuer = `https://${c.team}.cloudflareaccess.com`;
  fetchKeys ??= async () => {
    const r = await fetch(issuer + '/cdn-cgi/access/certs', { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw Error(`Access certs: HTTP ${r.status}`);
    return ((await r.json()) as { keys: Jwk[] }).keys;
  };
  // ponytail: JWKS cached 1 h, no refetch on an unknown kid; Cloudflare publishes a new key well before signing with it.
  let cache: { at: number; keys: Promise<Jwk[]> } | null = null;
  const keys = () => {
    if (!cache || Date.now() - cache.at > 3600_000) {
      const p = fetchKeys!();
      cache = { at: Date.now(), keys: p };
      p.catch(() => { cache = null; });
    }
    return cache.keys;
  };

  return async function verify(token: unknown): Promise<string | null> {
    try {
      if (typeof token !== 'string') return null;
      const [h, p, sig, extra] = token.split('.');
      if (!sig || extra !== undefined) return null;
      const head = JSON.parse(b64(h).toString()), claims = JSON.parse(b64(p).toString());
      if (head.alg !== 'RS256') return null;
      const jwk = (await keys()).find((k) => k.kid === head.kid);
      if (!jwk) return null;
      const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, ALG, false, ['verify']);
      if (!await crypto.subtle.verify(ALG, key, b64(sig), Buffer.from(`${h}.${p}`))) return null;
      const now = Date.now() / 1000, aud = [claims.aud].flat();
      if (claims.iss !== issuer || !aud.includes(c.aud) || !(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return null;
      return typeof claims.email === 'string' && claims.email ? claims.email.toLowerCase() : null;
    } catch { return null; }
  };
}
