# agent-remote-browser

One sandboxed Chromium per AI agent, driven through a remote MCP server.

An agent (e.g. a Notion Custom Agent) connects over MCP with OAuth or a static token. Each browser profile runs in its own Docker container: no network, all caps dropped, egress only through a per-profile proxy that enforces a domain allowlist and refuses private IPs. Saved logins are encrypted and typed by the gateway, the agent never sees them. A localhost-only admin UI manages profiles, logins, tokens and offers a live view.

Status: imported from the `agent-computer` POC, on its way to production. See the production plan (`projects/agent-computer/production-plan.md` in the parent workspace) and [SECURITY.md](SECURITY.md).

## Dev

Requires Node >= 24 (target runtime: Node 26) and Docker. TypeScript runs as-is (Node type stripping), no build step.

```sh
npm ci
npm test            # unit + integration on an in-memory FakeDriver, no Docker needed (< 1 s)
npm run typecheck

cp .env.example .env               # on macOS: ALLOW_NO_SANDBOX=1 (no gVisor)
mkdir -m 700 secrets && head -c 32 /dev/urandom > secrets/login_key && chmod 600 secrets/login_key   # once
docker compose up -d --build       # MCP on http://127.0.0.1:18787/mcp, admin on http://127.0.0.1:18788
curl 127.0.0.1:18787/readyz        # /healthz = process up, /readyz = Docker reachable
TOKEN=acp_... npm run smoke        # end-to-end MCP calls against the running stack
```

All Docker resources are named `${ARB_PREFIX:-arb}-*` (containers `arb-<profile>`, volumes `arb-profile-<profile>`, `arb-data`, `arb-egress`).

## Layout

- `src/server.ts`: entry point (`npm start`). Two listeners, graceful SIGTERM (drains, leaves browsers running), reconnects running browsers at startup.
- `src/config.ts`: every env var, validated with zod. Invalid config = exit 1. Refuses to start without `SANDBOX_RUNTIME=runsc` unless `ALLOW_NO_SANDBOX=1`; in production, requires `PUBLIC_URL` and refuses quick tunnels.
- `src/host/`: the `HostDriver` contract. `DockerDriver` talks to the Engine API (`/v1.47`) over the Unix socket; the gateway image has no docker CLI. `FakeDriver` backs the tests.
- `src/mcp/`, `src/admin/`, `src/oauth/`: MCP tools and leases, admin UI, OAuth server.
- `src/store/`: SQLite database (`db.ts`, `migrations/NNN_name.sql`), typed repository functions (`store.ts`), login envelopes (`logins-crypto.ts`).
- `src/cli.ts`: operator commands (`rotate-login-key`, `migrate-from-poc`).
- `src/egress/`, `src/policy.ts`, `src/audit.ts`: egress proxy, allowlist rules, audit file and JSON logs.

Logs are JSON lines on stdout (`{level,msg,profile,tool,ms}`), never arguments or secrets. The audit file (`AUDIT_FILE`) is separate.

The gateway runs as `node` (uid 1000). It reaches the Docker socket through `DOCKER_GID` (`group_add` in compose); on Linux, `secrets/login_key` must be readable by uid 1000.

## State

One SQLite file, `${DATA_DIR}/arb.db` (compose: volume `arb-data`, mounted at `/data`), mode 0600, WAL, foreign keys on. Tables: `profiles` (allowlist, profile token hash), `logins` (one AES-256-GCM envelope per saved login, with the `key_id` of the key that sealed it), `leases` (token hash, expiry: they survive a restart), `settings` (global token hash), `oauth_clients`, `oauth_tokens` (hashes only). Every token is stored as its sha256. Deleting a profile deletes its logins, leases and OAuth tokens (foreign key cascade).

Migrations: `src/store/migrations/NNN_name.sql`, applied at startup in order, one transaction each; `PRAGMA user_version` holds the last one applied. Add a file, never edit an applied one.

Database driver: `node:sqlite` (built into Node, no native dependency, no build stage). Evidence for Lot 4 (2026-11-21): `better-auth@1.7.27` (latest) depends on `@better-auth/kysely-adapter@1.7.27`, which ships a `NodeSqliteDialect` and picks it automatically when handed a `DatabaseSync`; `node:sqlite` runs without an experimental warning on Node 24.22.1 (SQLite 3.53.4) and Node 26.13.1 (SQLite 3.54.1). `better-sqlite3` would add a native build for nothing.

### Login key

`LOGIN_KEY_FILE` (default `/run/secrets/login_key`, the `login_key` Docker secret from `./secrets/login_key`): 32 random bytes, kept out of the data volume so a copy of `arb.db` alone exposes no password. At startup:
- saved logins exist and the key is missing: the gateway refuses to start (restore the key, never create a new one);
- the key does not match the `key_id` of the saved logins: refuses to start, naming the ids;
- no saved login and no key: creates one (0600) only if the path is writable, otherwise refuses with instructions. A Docker secret is read-only: create it yourself (command above).

Back up the key and `arb.db` separately.

### Operator commands

Run with the gateway stopped; they write `arb.db` and the key file, and print counts and ids only.

```sh
docker compose stop gateway
# The secret mount is read-only: rotate on the host file through a writable bind mount.
docker compose run --rm --no-deps -e LOGIN_KEY_FILE=/secrets/login_key -v "$PWD/secrets:/secrets" gateway node src/cli.ts rotate-login-key
docker compose start gateway
```

`rotate-login-key` writes a new key to `<key>.new`, re-encrypts every login in one transaction, then renames `<key>` to `<key>.old` and `<key>.new` to `<key>`. On failure nothing changes. Delete `<key>.old` once no backup of `arb.db` needs it. A crash between the commit and the renames leaves the live key in `<key>.new`: the startup error names the key id it expects.

`migrate-from-poc <state.json> <poc-login.key> [--apply]` imports the POC's profiles, allowlists and saved logins (decrypted with the POC key, re-encrypted with the current one, each verified) in one transaction. Profile ids already in `arb.db` are left untouched. POC tokens and OAuth data are not imported: generate new profile and global tokens in the admin UI; agents reconnect. Dry run by default (rolls back, prints the `docker volume create` / `docker run ... alpine:3.22 cp -a` commands that copy each `ac-profile-<id>` volume to `arb-profile-<id>`). `--apply` commits and copies through the Engine API (never overwrites an existing target). Mount the POC files read-only into a one-off container:

```sh
docker compose run --rm --no-deps -v /path/to/poc/state.json:/poc/state.json:ro -v /path/to/poc/login.key:/poc/login.key:ro \
  gateway node src/cli.ts migrate-from-poc /poc/state.json /poc/login.key            # then again with --apply
```
