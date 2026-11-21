# agent-remote-browser

One sandboxed Chromium per AI agent, driven through a remote MCP server.

An agent (e.g. a Notion Custom Agent) connects over MCP with OAuth 2.1 or an API key. Each browser profile runs in its own Docker container: no network, all caps dropped, egress only through a per-profile proxy that enforces a domain allowlist and refuses private IPs. Saved logins are encrypted and typed by the gateway, the agent never sees them. A localhost-only admin UI (password + TOTP) manages profiles, logins, API keys and connected clients, and offers a live view.

Status: imported from the `agent-computer` POC, on its way to production. See the production plan (`projects/agent-computer/production-plan.md` in the parent workspace) and [SECURITY.md](SECURITY.md).

**Running it on a server: [deploy/runbook.md](deploy/runbook.md)** (prerequisites, secrets, tunnel or not, agents, upgrades, uninstall).

## Deploy

Two compose files, same stack:

- `compose.yaml`: no tunnel. MCP published on `${BIND_ADDR:-127.0.0.1}:18787`, admin on `127.0.0.1:18788` whatever `BIND_ADDR` is. TLS is yours (reverse proxy, runbook section 3).
- `compose.tunnel.yaml`: an override of `compose.yaml` (`COMPOSE_FILE=compose.yaml:compose.tunnel.yaml` in `.env`), with `ports: !reset []` on the gateway (nothing published) and a `cloudflared` named tunnel (`tunnel run`, token in the `cloudflared_token` Docker secret, never a quick tunnel). The gateway runs with `NODE_ENV=production` (`PUBLIC_URL` required) and `TRUST_PROXY=cloudflare`.

`TRUST_PROXY=cloudflare` is the only setting under which `Cf-Connecting-IP` (the rate-limit key) is read from the request; otherwise the gateway overwrites it with the TCP peer address. The admin UI is never on the tunnel unless `ADMIN_PUBLIC=1`, which requires Cloudflare Access (`ACCESS_AUD`, `ACCESS_TEAM`): the gateway refuses to boot without it. The runner starts at most `MAX_COMPUTERS` browsers at once (default 4); past that the agent gets `Too many computers running`. Every image is pinned by digest (`node` and `alpine` in the source, `cloudflared` in `compose.tunnel.yaml`); `npm run check:compose` validates both setups and these exposure rules.

## Dev

Requires Node >= 24 (target runtime: Node 26) and Docker. TypeScript runs as-is (Node type stripping), no build step.

```sh
npm ci
npm test            # unit + integration on an in-memory FakeDriver, no Docker needed (< 1 s)
npm run typecheck

cp .env.example .env               # on macOS: ALLOW_NO_SANDBOX=1 (no gVisor)
mkdir -m 700 secrets && head -c 32 /dev/urandom > secrets/login_key                     # once
openssl rand -base64 48 | tr -d '\n' > secrets/better_auth_secret && chmod 600 secrets/*   # once
docker compose up -d --build       # MCP on http://127.0.0.1:18787/mcp, admin on http://127.0.0.1:18788
curl 127.0.0.1:18787/readyz        # /healthz = process up, /readyz = runner and Docker reachable
docker compose exec gateway node src/cli.ts admin create you@example.com   # once, see Admin below
```

`npm run smoke` (`test/e2e/smoke.ts`) runs end to end against a **fresh** stack (it creates the admin itself, with a generated password): admin login with TOTP, a profile and a scoped API key, MCP open/snapshot/refusal, the computer's hardening (read-only rootfs, writable tmpfs, `EXPECT_RUNTIME`), `/metrics`, hostile requests on the runner socket, `backup-db`.

## CI and releases

- `.github/workflows/ci.yml`, on every push and PR: typecheck + tests on Node 24 and 26, `check:compose`; both images built and scanned by Trivy (fails on a CRITICAL vulnerability that has a fix); and the e2e job: gVisor installed from its signed apt repository and registered with Docker, the stack up with `SANDBOX_RUNTIME=runsc` (no `ALLOW_NO_SANDBOX`), the smoke, `migrate-from-poc --apply` from a synthetic POC state and an `ac-profile-legacy` volume created in the job, then `deploy/backup.sh` into a local restic repository and the runbook's restore drill, real restore and profile-volume restore. Every credential is generated in the job; only `GITHUB_TOKEN` is used.
- `.github/workflows/release.yml`, on a `v*` tag: Trivy gate on the amd64 build, then `linux/amd64` + `linux/arm64` images pushed to `ghcr.io/<owner>/agent-remote-browser-{gateway,computer}:<tag>` (and `:sha-<commit>`), with an SBOM and a provenance attestation. Run them with `ARB_IMAGE_REPO=ghcr.io/<owner>/agent-remote-browser ARB_IMAGE_TAG=<tag>` (runbook, Upgrade); without these variables compose builds locally as before.
- `renovate.json`: npm, Dockerfile and compose digests, GitHub Actions (pinned by commit SHA), the `agent-browser` version and the copy image in `src/host/docker.ts`. Minor, patch and digest updates come as one weekly PR; Better Auth and `agent-browser` get their own. Needs the Renovate GitHub app on the repository.
- Actions are pinned by commit SHA; workflows get `contents: read` (release adds `packages: write`). Trivy is a checksum-verified release binary (`.github/trivy.sh`), not `trivy-action`.

## Metrics

`GET /metrics` on the admin listener only (`127.0.0.1:18788`; Host must be an IP or a single-label name such as `gateway`, against DNS rebinding; no session, so a local Prometheus can scrape it; 404 on the public listener), Prometheus text format, no dependency (`src/metrics.ts`). Counters reset when the gateway restarts:

- `arb_http_requests_total{listener="mcp"|"admin"}`
- `arb_tool_calls_total{tool,outcome="ok"|"error"}`
- `arb_auth_failures_total{kind="token"|"password"|"totp"|"rate_limited"}`
- `arb_egress_denied_total`
- gauges, read at scrape time: `arb_runner_up`, `arb_computers_running`, `arb_leases_active`

Labels come from fixed sets (listener, tool name, outcome, failure kind): never a profile id, URL or credential.

All Docker resources are named `${ARB_PREFIX:-arb}-*` (containers `arb-<profile>`, volumes `arb-profile-<profile>`, `arb-data`, `arb-egress`, `arb-runner`).

## Layout

- `src/server.ts`: entry point (`npm start`). Two listeners, graceful SIGTERM (drains, leaves browsers running), reconnects running browsers at startup.
- `src/config.ts`: every env var, validated with zod (`loadConfig` for the gateway, `loadRunnerConfig` for the runner). Invalid config = exit 1. The runner refuses to start without `SANDBOX_RUNTIME=runsc` unless `ALLOW_NO_SANDBOX=1`; in production (`NODE_ENV=production`, set by `compose.tunnel.yaml`), the gateway requires `PUBLIC_URL` and refuses quick tunnels.
- `src/host/`: the `HostDriver` contract. `RunnerDriver` (gateway side) speaks the runner RPC; `DockerDriver` (runner side) talks to the Engine API (`/v1.47`) over the Docker socket, no docker CLI. `FakeDriver` backs the tests.
- `src/runner/`: the runner (`server.ts`) and its RPC (`protocol.ts`: one JSON line per connection, zod-validated, argv allowlist).
- `src/mcp/`, `src/admin/`: MCP tools and leases, admin UI.
- `src/auth/`: Better Auth setup (`better-auth.ts`), public login/consent/OAuth routes (`routes.ts`), token and admin checks (`guards.ts`), Cloudflare Access JWT (`access-jwt.ts`).
- `src/store/`: SQLite database (`db.ts`, `migrations/NNN_name.sql`), typed repository functions (`store.ts`), login envelopes (`logins-crypto.ts`).
- `src/cli.ts`: operator commands (`admin create`, `admin reset-2fa`, `rotate-login-key`, `migrate-from-poc`, `backup-db`).
- `src/metrics.ts`: Prometheus counters and exposition.
- `src/egress/`, `src/policy.ts`, `src/audit.ts`: egress proxy, allowlist rules, audit file and JSON logs.
- `deploy/`: operator runbook, `backup.sh` (restic), `check-compose.ts` (`npm run check:compose`).
- `test/unit`, `test/integration` (`npm test`), `test/e2e` (smoke and the CI's POC fixture), `.github/` (CI, release, Trivy).

Logs are JSON lines on stdout (`{level,msg,profile,tool,ms}`), never arguments or secrets. The audit file (`AUDIT_FILE`) is separate.

## Gateway and runner

Two services, one image (`Dockerfile.gateway`), both `node` (uid 1000), read-only root filesystem, all capabilities dropped:

- **gateway**: MCP, admin UI, OAuth, egress proxies, `arb.db`. No Docker socket. On Linux, `secrets/login_key` must be readable by uid 1000.
- **runner**: the only service with `/var/run/docker.sock` (through `DOCKER_GID`, `group_add`), `network_mode: none`. Listens on `/run/arb-runner/runner.sock` (0600, in a 0700 directory on the `arb-runner` volume, mounted by these two services only). It starts at most `MAX_COMPUTERS` computers at once (default 4; ensures are serialized so the count holds). It accepts a profile id plus one op (`ensure`, `exec`, `stream`, `stop`, `remove`, `list`, `copyVolume`), never an image, mount, container name or free command line. Containers are created from the computer image (`IMAGE`, set by compose to `${ARB_PREFIX}-computer:dev` or the released one) with fixed settings (runtime, no network, no caps, read-only rootfs, `arb-egress` mounted read-only at the profile's subpath, profile volume). `exec` only runs the `agent-browser` calls the gateway makes (fixed flags) and three helpers (`base64`/`rm -f` of a screenshot, `cat` of the session file), under `timeout -k 5`. `stop`/`remove`/`list` only touch containers carrying the stack's label. A refused request gets `invalid request` and a `runner refused a request` warning in the runner's logs.
- Healthcheck: `node src/runner/server.ts check` (one `list` round trip). The gateway starts once the runner is healthy.

## State

One SQLite file, `${DATA_DIR}/arb.db` (compose: volume `arb-data`, mounted at `/data`), mode 0600, WAL, foreign keys on. Tables: `profiles` (allowlist), `logins` (one AES-256-GCM envelope per saved login, with the `key_id` of the key that sealed it), `leases` (token hash, expiry: they survive a restart), and Better Auth's tables (`user`, `account`, `session`, `twoFactor`, `verification`, `apikey`, `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `rateLimit`, ...). Every token is stored as its sha256 (OAuth access/refresh tokens, API keys, leases); TOTP secrets are encrypted with `BETTER_AUTH_SECRET`. Deleting a profile deletes its logins and leases (foreign key cascade), and its OAuth tokens, consents, pending codes and API keys.

Migrations: `src/store/migrations/NNN_name.sql`, applied at startup in order, one transaction each; `PRAGMA user_version` holds the last one applied. Add a file, never edit an applied one. Better Auth's tables come from `002_better_auth.sql`, never from its own auto-migration; `002` also drops the Lot 3 `oauth_clients`, `oauth_tokens`, `settings` and `profiles.token_hash` (old tokens stop working, agents reconnect). Bumping `better-auth` = diff its schema (`npx @better-auth/cli generate`) and add a migration.

Database driver: `node:sqlite` (built into Node, no native dependency, no build stage). Evidence for Lot 4 (2026-11-21): `better-auth@1.7.27` (latest) depends on `@better-auth/kysely-adapter@1.7.27`, which ships a `NodeSqliteDialect` and picks it automatically when handed a `DatabaseSync`; `node:sqlite` runs without an experimental warning on Node 24.22.1 (SQLite 3.53.4) and Node 26.13.1 (SQLite 3.54.1). `better-sqlite3` would add a native build for nothing.

## Auth

Better Auth `1.7.27` (pinned, with `@better-auth/oauth-provider`, `@better-auth/api-key`, `@better-auth/cimd`; `twoFactor` built in), on the same `arb.db`. Model and threats: [SECURITY.md](SECURITY.md).

- **Agents, OAuth 2.1**: `/.well-known/oauth-protected-resource` points to the issuer `${PUBLIC_URL}/api/auth`. Dynamic client registration (or a CIMD client id URL), PKCE S256 only, access tokens `arb_at_` (1 h), refresh tokens `arb_rt_` (30 days, rotated). The admin signs in on `/login` (password + TOTP) and picks on `/consent` which scope the client gets: `profile:<id>` or `global`. Signups are disabled.
- **Agents, API keys**: `arb_k_...`, created in the admin UI with a scope (`profile:<id>` or `global`), shown once. Send as `Authorization: Bearer` or `x-api-key`.
- **Admin**: one admin per gateway, email + password (12 to 128 characters) + mandatory TOTP. Session cookie, 12 h. Host and Origin checked on every call. Admin UI on `:18788` (localhost) only, unless `ADMIN_PUBLIC=1` (then also on `PUBLIC_URL`, behind Cloudflare Access: `ACCESS_AUD` and `ACCESS_TEAM` are required; the Access email must be the admin's). When `PUBLIC_URL` is https, the `:18788` listener uses its own Better Auth instance (same database and secret) with base URL `http://localhost:18788`, so its cookies carry no `Secure`/`__Secure-` prefix and still work through an SSH forward; the public listener's cookies are `Secure`. The Access JWKS is cached 1 h and refetched on an unknown key id (at most once a minute).
- **Limits** (stored in `rateLimit`, per client IP: `cf-connecting-ip` with `TRUST_PROXY=cloudflare`, else the TCP peer address): sign-in 5/min, TOTP 5/min (then 15 min lockout after 5 failures), consent 10/min, token 30/min. Client registration: 5/min per IP, 20/h and 1000 clients overall; clients never granted anything are purged after 24 h.
- `BETTER_AUTH_SECRET` (Docker secret `better_auth_secret`, at least 32 characters) signs cookies and encrypts TOTP secrets. Changing it signs everyone out and invalidates every TOTP enrolment (`admin reset-2fa`). `PUBLIC_URL` is Better Auth's base URL (`BETTER_AUTH_URL`).

### Admin

```sh
docker compose exec gateway node src/cli.ts admin create you@example.com   # password, then a TOTP code
docker compose exec gateway node src/cli.ts admin reset-2fa you@example.com # new password + new TOTP, sessions dropped
```

Both prompt for the password (hidden on a TTY, one line on stdin otherwise), print an `otpauth://` URI to add to an authenticator app, then ask for a code from the app to confirm. **The `otpauth://` URI is the only secret the CLI ever prints**: add it to the app, then clear the terminal. Nothing else (password, `BETTER_AUTH_SECRET`, keys) is ever output. No backup codes: a lost authenticator = `admin reset-2fa` from the host.

### Login key

`LOGIN_KEY_FILE` (default `/run/secrets/login_key`, the `login_key` Docker secret from `./secrets/login_key`): 32 random bytes, kept out of the data volume so a copy of `arb.db` alone exposes no password. At startup:
- saved logins exist and the key is missing: the gateway refuses to start (restore the key, never create a new one);
- the key does not match the `key_id` of the saved logins: refuses to start, naming the ids;
- no saved login and no key: creates one (0600) only if the path is writable, otherwise refuses with instructions. A Docker secret is read-only: create it yourself (command above).

Back up the key and `arb.db` separately: `arb.db` with `deploy/backup.sh` (restic, consistent `backup-db` snapshot), the key in a password manager (runbook, section 10).

### Operator commands

Run with the gateway stopped; they write `arb.db` and the key file, and print counts and ids only.

```sh
docker compose stop gateway
# The secret mount is read-only: rotate on the host file through a writable bind mount.
docker compose run --rm --no-deps -e LOGIN_KEY_FILE=/secrets/login_key -v "$PWD/secrets:/secrets" gateway node src/cli.ts rotate-login-key
docker compose start gateway
```

`rotate-login-key` writes a new key to `<key>.new`, re-encrypts every login in one transaction, then renames `<key>` to `<key>.old` and `<key>.new` to `<key>`. On failure nothing changes. Delete `<key>.old` once no backup of `arb.db` needs it. A crash between the commit and the renames leaves the live key in `<key>.new`: the startup error names the key id it expects.

`migrate-from-poc <state.json> <poc-login.key> [--apply]` (runbook section 8 also covers copying the volumes by hand, flag off) imports the POC's profiles, allowlists and saved logins (decrypted with the POC key, re-encrypted with the current one, each verified) in one transaction. Profile ids already in `arb.db` are left untouched. POC tokens and OAuth data are not imported: create API keys in the admin UI or let agents reconnect through OAuth. Dry run by default (rolls back, prints the `docker volume create` / `docker run ... alpine:3.22@sha256:... cp -a` commands that copy each `ac-profile-<id>` volume to `arb-profile-<id>`). `--apply` commits and asks the runner to copy each volume (never overwrites an existing target). The runner picks the source itself (`ac-profile-<id>`) and refuses `copyVolume` unless started with `ALLOW_POC_MIGRATION=1`: without the flag, a compromised gateway could pull any POC profile's cookies into this stack. Mount the POC files read-only into a one-off container:

```sh
P="-v /path/to/poc/state.json:/poc/state.json:ro -v /path/to/poc/login.key:/poc/login.key:ro"
docker compose run --rm --no-deps $P gateway node src/cli.ts migrate-from-poc /poc/state.json /poc/login.key   # dry run
ALLOW_POC_MIGRATION=1 docker compose up -d runner      # recreates the runner with copyVolume enabled
docker compose stop gateway
docker compose run --rm --no-deps $P gateway node src/cli.ts migrate-from-poc /poc/state.json /poc/login.key --apply
docker compose up -d                                   # flag unset: runner recreated without it, gateway back
```
