# agent-remote-browser

One sandboxed Chromium per AI agent, driven through a remote MCP server.

An agent (e.g. a Notion Custom Agent) connects over MCP with OAuth or a static token. Each browser profile runs in its own Docker container: no network, all caps dropped, egress only through a per-profile proxy that enforces a domain allowlist and refuses private IPs. Saved logins are encrypted and typed by the gateway, the agent never sees them. A localhost-only admin UI manages profiles, logins, tokens and offers a live view.

Status: imported from the `agent-computer` POC, on its way to production. See the production plan (`projects/agent-computer/production-plan.md` in the parent workspace) and [SECURITY.md](SECURITY.md).

## Dev

Requires Node >= 24 (target runtime: Node 26) and Docker.

```sh
npm ci
npm test            # unit + integration, no Docker needed (< 30 s)
npm run typecheck

cp .env.example .env
docker compose up -d --build   # MCP on http://127.0.0.1:18787/mcp, admin on http://127.0.0.1:18788
```

All Docker resources are named `${ARB_PREFIX:-arb}-*` (containers `arb-<profile>`, volumes `arb-profile-<profile>`, `arb-keys`, `arb-egress`).

Browser check (real Chromium, inside the gateway): `docker compose exec -T gateway node check-browser.mjs`.
