# agent-computer — POC

Gives each Notion Custom Agent its own "computer": a Docker container with headless Chromium and [agent-browser](https://agent-browser.dev) 0.43.0, controlled through a **remote MCP server** (Streamable HTTP).

Plan and context: [`projects/agent-computer/README.md`](../../projects/agent-computer/README.md). This POC implements phases P2 to P5 with Docker as the sandbox.

```
Notion agent ──HTTPS + Bearer token (or OAuth)──► gateway.mjs ──docker exec──► ac-<profile> container
                                       auth · lease · allowlist · audit · kill switch   Chromium + agent-browser
                                       login() injects secrets                           volume ac-profile-<profile>
```

A **profile** is one browser: its own container, cookies, saved logins, allowlist and access token.

## Run it (Docker Compose)

```bash
docker compose up -d --build            # builds both images, gateway on http://127.0.0.1:8787/mcp, admin on :8788
# create a profile in the admin UI, copy its token, then:
TOKEN=acp_... node smoke.mjs            # end-to-end test through MCP
```

- `gateway` runs in a container and starts the agent computers as **sibling containers** through the mounted Docker socket.
- `computer-image` only builds `agent-computer:dev`, then exits. Seeing it as `exited` is normal.
- `data/` holds `audit.jsonl` and `state.json` (profiles, token hashes, saved logins, OAuth clients; mode 0600). Run `touch data/KILL` to turn on the kill switch.
- Port 8787 is bound to `127.0.0.1` only.
- `docker compose down` leaves the agent containers and their `ac-profile-*` volumes in place. To remove them, delete the profiles in the admin UI or run `docker rm -f $(docker ps -aq --filter label=agent-computer)`.

### Admin UI — http://localhost:8788

- **New profile**: id + allowed domains. Its token is shown **once** (only a hash is stored). **Regenerate token** revokes the old one and its OAuth sessions.
- **Provisioning**: Take control and log in by hand (cookies stay in the profile), and/or **Saved logins** (site, URL, username, password) for the agent's `login` tool. Passwords are write-only in the UI.
- **Save domains** changes the allowlist and restarts the browser. **Delete profile** removes container, volume, logins and tokens.
- **Global token**: generated here, shown once.
- Lists every profile: up/down, lease, last call, idle countdown, live viewers.
- Shows page URL/title, allowlist, logins, recent calls, cookies (name/domain/expiry/flags, **never values**) and localStorage origins. Cookies come from agent-browser's saved session, so they show even when the computer is stopped (≤30 s lag while up).
- **Watch** streams the browser live (agent-browser stream, JPEG frames). **Take control** starts the computer if needed and forwards mouse/keyboard. A computer with a viewer is never idle-stopped.
- Stream relay: `docker exec -i … node` pipes the WebSocket to the stream port inside the container, so no network between gateway and computers.
- Security: separate port bound to `127.0.0.1`, Host must be localhost (DNS rebinding), browser Origin must match the exact admin origin, cross-site fetches are refused, and POST requires JSON, every start/stop/view goes to the audit log as `admin:*`. No auth beyond that: **never expose 8788 through the tunnel.**
- Not done: clipboard paste, multi-tab, file upload.

To run without Compose: `docker build -t agent-computer:dev . && npm install && node gateway.mjs`.

### Connect a Notion Custom Agent

1. Expose the gateway with `docker compose --profile tunnel up -d`. The `https://….trycloudflare.com` URL appears in `docker compose logs tunnel`.
2. Notion → agent settings → Tools → add a custom MCP, URL `https://…/mcp`, then either:
   - **OAuth**: the client discovers the server, registers itself (DCR), and opens a page that asks for the access token. Paste the profile token (or the global token).
   - **Header**: `Authorization: Bearer <token>` (`x-api-key: <token>` also works).
   - Prerequisites: Business or Enterprise plan, and an admin enabled custom MCP connectors under Settings → Notion AI → AI connectors.
3. Agent instruction to add: *"To browse: `open`, then `snapshot` for refs, then `click`/`fill`. To log in, always use `login`."*

## Tools exposed

| Tool | Notes |
|------|-------|
| `open(url)` | Rejected if the domain is not in the agent's `allow` list |
| `snapshot()` | Interactive elements with refs `@e1`, `@e2`… |
| `get_text(ref?)` | Page or element text, capped at 50 KB |
| `click(ref)` · `fill(ref, text)` · `press(key)` · `back()` | Refs only, no CSS selectors |
| `screenshot()` | PNG returned as an MCP image |
| `login(site)` | Credentials saved in the admin UI. The password goes over stdin to `agent-browser auth`, and the LLM only gets back `{submitted, url}` |

With the **global token**, every browser tool above takes an extra `lease` argument, and four more tools exist:

| Tool | Notes |
|------|-------|
| `list_profiles()` | id, allowlist, login sites, lease state. Never a token |
| `create_profile(id, allow)` | Empty profile, no token. A human adds logins in the UI |
| `lease_profile(profile? \| domain?, minutes=15)` | Exclusive use. Returns `{lease, profile, allow, logins, expiresAt}`. Expiry slides with each call (max 120 min idle) |
| `release_profile(lease)` | |

While a profile is leased, its own token gets "leased until …". The admin UI is not blocked (human override) and can release a lease. Leases live in memory: a gateway restart frees them.

Not exposed: `eval`, upload, multi-tab, downloads, profile deletion (UI only).

## Auth

| Token | Prefix | Where | Gives |
|-------|--------|-------|-------|
| Profile token | `acp_` | Admin UI, per profile | That profile's browser |
| Global token | `acg_` | Admin UI | Create, list, lease profiles |
| OAuth access / refresh | `aca_` / `acr_` | `/token` | Same as the token pasted on the consent page. Access 1 h, refresh 30 days, rotated |

OAuth endpoints (MCP auth spec): `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register` (DCR, https redirect URIs, or http on loopback), `/authorize` (PKCE S256 required, 5 tries per request), `/token`. A 401 on `/mcp` carries `WWW-Authenticate: Bearer resource_metadata=…`. Codes and pending requests live in memory.

The issuer comes from `PUBLIC_URL`, else from the request Host. A quick tunnel gets a new URL on each restart, so clients must reconnect. Use a named tunnel + `PUBLIC_URL` for anything lasting.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | 8787 | |
| `IDLE_MIN` | 5 | Minutes idle before `agent-browser close` and `docker stop`. The volume is kept |
| `SANDBOX_RUNTIME` | – | `runsc` for gVisor on the Linux VM |
| `IMAGE` | `agent-computer:dev` | |
| `PUBLIC_URL` | – | OAuth issuer, e.g. `https://browser.example.com` |
| `STATE_FILE` / `AUDIT_FILE` / `KILL_FILE` | next to the gateway | `touch KILL` makes every call fail |

## Security in place

- **One container per agent:** `--cap-drop=ALL`, `no-new-privileges`, non-root uid 10001, `pids-limit 512`, 1 GB RAM, 1 CPU. Chromium runs with `--no-sandbox` because the container is the sandbox.
- **Allowlist, two layers:**
  - The gateway checks every `open` call.
  - Docker gives each browser only loopback. Its local proxy reaches a gateway Unix socket mounted for that profile. The gateway checks the hostname, resolves IPv4, rejects special-use addresses and connects to the checked address. Only standard HTTP and HTTPS ports are supported. Chromium policy blocks local files and privileged navigation schemes.
- Saved passwords use AES-256-GCM. Startup migrates legacy records in place. Back up the Compose `ac-keys` volume separately from `data/` and restore both together. The gateway passes a password through stdin and restricts new connections to the configured HTTPS origin during login. Sites requiring cross-origin sign-in can use manual Take control.
- **Untrusted content:** `snapshot` and `get_text` output is wrapped in `<untrusted_page_content>`.
- **Audit:** `audit.jsonl` records agent, tool, success flag and duration for every call.
- **Persistence** (Chrome profile plus agent-browser `--restore`): cookies, including session cookies, and localStorage survive a container stop/start. Tested: still logged in after the reaper ran.

OAuth registration permits 20 requests per hour per gateway, with a ceiling of 1,000 clients. Consent permits 40 token checks per minute across clients and five failures per pending request. At capacity the gateway refuses new registrations. Configure `PUBLIC_URL` for a custom issuer domain.

Run `node check.mjs` and `node check-oauth.mjs` for isolated checks. After building the stack, `docker compose exec -T gateway node check-browser.mjs` exercises Chromium using a disposable container. See [the threat model](SECURITY.md).

## Known limits (ponytail)

| Limit | Upgrade |
|-------|---------|
| Profile volume stored in plaintext on disk | Encrypted volume, or `AGENT_BROWSER_ENCRYPTION_KEY` + KMS |
| Single host, gateway holds the Docker socket (= host root), state in memory | Fine for <20 agents. Beyond that: orchestrator (Nomad/K8s) or a managed sandbox |
| No per-agent quota (minutes/day) | Counter in the audit log + refuse calls when exceeded |
| Notion has not been tested yet (timeouts, image results) | Phase P0 of the plan |

## Measurements (MacBook, arm64)

- Cold start (container + Chromium + first `open`): ~1.5 s
- `snapshot` / `click` / `get_text`: 50–110 ms
- `login` (save + fill + submit + delete): ~1.8 s
