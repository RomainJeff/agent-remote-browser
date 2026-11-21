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
docker compose up -d --build       # MCP on http://127.0.0.1:18787/mcp, admin on http://127.0.0.1:18788
curl 127.0.0.1:18787/readyz        # /healthz = process up, /readyz = Docker reachable
TOKEN=acp_... npm run smoke        # end-to-end MCP calls against the running stack
```

All Docker resources are named `${ARB_PREFIX:-arb}-*` (containers `arb-<profile>`, volumes `arb-profile-<profile>`, `arb-keys`, `arb-egress`).

## Layout

- `src/server.ts`: entry point (`npm start`). Two listeners, graceful SIGTERM (drains, leaves browsers running), reconnects running browsers at startup.
- `src/config.ts`: every env var, validated with zod. Invalid config = exit 1. Refuses to start without `SANDBOX_RUNTIME=runsc` unless `ALLOW_NO_SANDBOX=1`; in production, requires `PUBLIC_URL` and refuses quick tunnels.
- `src/host/`: the `HostDriver` contract. `DockerDriver` talks to the Engine API (`/v1.47`) over the Unix socket; the gateway image has no docker CLI. `FakeDriver` backs the tests.
- `src/mcp/`, `src/admin/`, `src/oauth/`: MCP tools and leases, admin UI, OAuth server.
- `src/egress/`, `src/store/`, `src/policy.ts`, `src/audit.ts`: egress proxy, state file, allowlist rules, audit file and JSON logs.

Logs are JSON lines on stdout (`{level,msg,profile,tool,ms}`), never arguments or secrets. The audit file (`AUDIT_FILE`) is separate.

The gateway runs as `node` (uid 1000). It reaches the Docker socket through `DOCKER_GID` (`group_add` in compose); on Linux, `./data` must be writable by uid 1000.
