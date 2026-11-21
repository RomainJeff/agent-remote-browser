# agent-remote-browser security boundaries

The public listener accepts untrusted OAuth clients. MCP tokens delegate use of a browser with real sessions. Pages, tool arguments and browser output are untrusted. The operator, gateway, Docker daemon and local machine are trusted.

| Finding | Severity × effort | Disposition |
| --- | --- | --- |
| Gateway socket grants host control | Critical × high | Residual. Container creation with arbitrary mounts is sufficient for host control. An endpoint-only socket proxy still permits this. A dedicated VM or a validating broker is needed. |
| Browser access to LAN, metadata or other profiles | High × high | Fixed for private and special-use destinations. Docker network mode is none. A per-profile Unix socket accepts allowed domains on ports 80/443 and connects to a checked IPv4 address. Deployments routing globally numbered addresses to private services need additional routing policy. |
| Cross-origin admin writes and WebSocket access | High × low | Fixed. Require same-origin browser requests, loopback Host and JSON writes. |
| Clear saved passwords | High × medium | Fixed. Encrypt and authenticate credentials with a key mounted as a Docker secret, outside the data volume. Each envelope records the id of its key; the gateway refuses to start with a missing or different key. |
| Sensitive request arguments and errors in logs | High × low | Fixed for new entries. Record operation metadata only. Historical logs require separate operator review. |
| Public registration and consent abuse | Medium × low | Fixed. Every grant needs the admin's password + TOTP on the consent page. Registration: 5/min per IP, 20/h and 1000 clients gateway-wide; unused clients purged after 24 h. Sign-in, TOTP, consent and token endpoints rate-limited in the database. |
| Stolen admin password | High × low | Fixed. TOTP is mandatory: password alone yields no session with admin rights. 5 failed codes = 15 min lockout. |
| Malicious content on a trusted login site | High × high | Residual. A saved login trusts the configured site, its scripts and the browser automation package. |
| Saved browser sessions and host backups | High × medium | Residual. Use encrypted host storage and protect backups. |


Local native processes and Docker peers with gateway network access remain trusted. Shared OAuth budgets can be exhausted deliberately, delaying new connections. Public sites and scripts on an allowed origin can still receive data available to that browser. A CONNECT proxy controls the upstream IP and port, while the browser validates TLS. It does not inspect encrypted application traffic.

## Authentication model

Better Auth 1.7.27 (pinned) on `arb.db`. One human, the admin; every agent credential is a grant the admin made.

| Who | Proves itself with | Gets |
| --- | --- | --- |
| Admin | Email + password (hashed, scrypt) + TOTP, then a session cookie (12 h, HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https) | Admin UI and API. Created only by `arb admin create` on the host; signups are disabled and not routed. |
| OAuth client (Notion, Claude, ...) | Access token `arb_at_` (1 h) / refresh token `arb_rt_` (30 days, rotated) from the authorization code flow with PKCE S256 | The scope the admin picked on the consent page: `profile:<id>` (browser tools on that profile only) or `global` (profile management and leases). Requested OAuth scopes (`mcp`, `offline_access`) never widen it. |
| Script / orchestrator | API key `arb_k_`, Bearer or `x-api-key` | The scope set at creation, same two shapes. |

- **Consent is the gate.** An unauthenticated client can register (DCR) or present a CIMD URL, but gets nothing until the admin signs in on `/login` (password + TOTP) and accepts on `/consent`. Consent without a session redirects to `/login`. Login and consent forms check Origin and refuse framing (`frame-ancestors 'none'`).
- **Tokens are opaque and hashed.** Access tokens, refresh tokens, API keys and leases are stored as sha256; `/mcp` looks the token up and re-checks that the profile still exists. Revocation (admin UI, "Connected clients") deletes the rows: effective on the next call. Replaying an authorization code revokes the tokens it produced. Deleting a profile deletes every token, key, consent and pending code scoped to it.
- **Admin surface.** Port 18788, published on localhost only; Host and Origin checked on every call (DNS rebinding, CSRF, cross-site WebSocket). `ADMIN_PUBLIC=1` also serves it on `PUBLIC_URL`; then put Cloudflare Access in front and set `ACCESS_AUD`/`ACCESS_TEAM`: the gateway verifies the `Cf-Access-Jwt-Assertion` itself (RS256, WebCrypto, team JWKS cached 1 h, `aud`, `iss`, `exp`/`nbf`) and requires its email to be the admin's.
- **Secrets.** `BETTER_AUTH_SECRET` (Docker secret) signs cookies and encrypts TOTP secrets in `arb.db`. The CLI prints exactly one secret, the `otpauth://` URI at enrolment, once.
- **Residual.** The client IP for rate limits is `cf-connecting-ip`, spoofable when the listener is reached without Cloudflare (limits then bound per header value; the TOTP lockout still applies per account). A TOTP code can be replayed within its 30 s window. The consent page's profile choice is held in memory for the duration of one request. No backup codes: losing the authenticator needs host access (`admin reset-2fa`). The JWKS is not refetched on an unknown key id until the hour is up (Access key rotation can lock the public admin out for up to 1 h; the localhost admin still works). CIMD client fetching is enabled but not exercised by the tests.

## State at rest

`arb.db` (SQLite, data volume, 0600) holds hashes of every token (OAuth access and refresh, API key, lease), the admin's password hash, TOTP secrets encrypted with `BETTER_AUTH_SECRET`, sessions, allowlists, OAuth client registrations and saved logins as AES-256-GCM envelopes bound to profile, site, URL and username. No plaintext credential is written to it (session tokens excepted: they are the cookie values, valid 12 h; Better Auth stores them as is). The login key lives in a separate Docker secret: a copy of the database or of the data volume alone discloses no password; a copy of both does. `rotate-login-key` re-encrypts every login in one transaction and keeps the previous key as `<key>.old` until the operator deletes it. Browser profile volumes (`arb-profile-*`: cookies, sessions) remain plaintext on the host disk (residual, row above).
