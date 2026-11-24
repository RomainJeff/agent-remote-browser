# Reference

Operator and developer details. Overview: [README](../README.md). Running it on a server: [deploy/runbook.md](../deploy/runbook.md). Open security topics: [SECURITY.md](../SECURITY.md).

## Deploy

Two compose files, same stack:

- `compose.yaml`: no tunnel. MCP published on `${BIND_ADDR:-127.0.0.1}:18787`, admin on `127.0.0.1:18788` whatever `BIND_ADDR` is. TLS is yours (reverse proxy, runbook section 3).
- `compose.tunnel.yaml`: an override of `compose.yaml` (`COMPOSE_FILE=compose.yaml:compose.tunnel.yaml` in `.env`), with `ports: !reset []` on the gateway (nothing published) and a `cloudflared` named tunnel (`tunnel run`, token in the `cloudflared_token` Docker secret, never a quick tunnel). The gateway runs with `NODE_ENV=production` (`PUBLIC_URL` required) and `TRUST_PROXY=cloudflare`.

`TRUST_PROXY=cloudflare` is the only setting under which `Cf-Connecting-IP` (the rate-limit key) is read from the request; otherwise the gateway overwrites it with the TCP peer address. The admin UI is never on the tunnel unless `ADMIN_PUBLIC=1`, which requires Cloudflare Access (`ACCESS_AUD`, `ACCESS_TEAM`): the gateway refuses to boot without it. The runner starts at most `MAX_COMPUTERS` browsers at once (default 4); past that the agent gets `Too many computers running`. Every image is pinned by digest (`node` in the `Dockerfile`s, `alpine` in `deploy/backup.sh`, `cloudflared` in `compose.tunnel.yaml`); `npm run check:compose` validates both setups and these exposure rules.

## CI

- `.github/workflows/ci.yml`, on every push and PR: typecheck + tests on Node 24 and 26, `check:compose`; both images built and scanned by Trivy (fails on a CRITICAL vulnerability that has a fix); and the e2e job: gVisor installed from its signed apt repository and registered with Docker, the stack up with `SANDBOX_RUNTIME=runsc` (no `ALLOW_NO_SANDBOX`), the smoke, a second profile seeded with a saved login and a marker on its volume, then `deploy/backup.sh` into a local restic repository and the runbook's restore drill, real restore and profile-volume restore. Every credential is generated in the job; only `GITHUB_TOKEN` is used.
- `renovate.json`: npm, Dockerfile and compose digests, GitHub Actions (pinned by commit SHA), the `agent-browser` version and the backup helper image in `deploy/backup.sh`. Minor, patch and digest updates come as one weekly PR; Better Auth and `agent-browser` get their own. Needs the Renovate GitHub app on the repository.
- Actions are pinned by commit SHA; the workflow gets `contents: read`. Trivy is a checksum-verified release binary (`.github/trivy.sh`), not `trivy-action`.

## Metrics

`GET /metrics` on the admin listener only (`127.0.0.1:18788`; Host must be an IP or a single-label name such as `gateway`, against DNS rebinding; no session, so a local Prometheus can scrape it; 404 on the public listener), Prometheus text format, no dependency (`src/metrics.ts`). Counters reset when the gateway restarts:

- `arb_http_requests_total{listener="mcp"|"admin"}`
- `arb_tool_calls_total{tool,outcome="ok"|"error"}`
- `arb_auth_failures_total{kind="token"|"password"|"totp"|"rate_limited"}`
- `arb_egress_denied_total`
- `arb_handoff_total{outcome="done"|"failed"|"expired"|"cancelled"}`, `arb_handoff_seconds_sum` / `_count{outcome}` (request to end)
- gauges, read at scrape time: `arb_runner_up`, `arb_computers_running`, `arb_leases_active`, `arb_handoffs_open`

Labels come from fixed sets (listener, tool name, outcome, failure kind): never a profile id, URL, handoff reason or credential.

All Docker resources are named `${ARB_PREFIX:-arb}-*` (containers `arb-<profile>`, volumes `arb-profile-<profile>`, `arb-data`, `arb-egress`, `arb-runner`).

## Layout

- `src/server.ts`: entry point (`npm start`). Two listeners, graceful SIGTERM (drains, leaves browsers running), reconnects running browsers at startup.
- `src/config.ts`: every env var, validated with zod (`loadConfig` for the gateway, `loadRunnerConfig` for the runner). Invalid config = exit 1. The runner refuses to start without `SANDBOX_RUNTIME=runsc` unless `ALLOW_NO_SANDBOX=1`; in production (`NODE_ENV=production`, set by `compose.tunnel.yaml`), the gateway requires `PUBLIC_URL` and refuses quick tunnels.
- `src/host/`: the `HostDriver` contract. `RunnerDriver` (gateway side) speaks the runner RPC; `DockerDriver` (runner side) talks to the Engine API (`/v1.47`) over the Docker socket, no docker CLI. `FakeDriver` backs the tests.
- `src/runner/`: the runner (`server.ts`) and its RPC (`protocol.ts`: one JSON line per connection, zod-validated, argv allowlist).
- `src/mcp/`, `src/admin/`: MCP tools and leases, admin UI.
- `src/auth/`: Better Auth setup (`better-auth.ts`), public login/consent/OAuth routes (`routes.ts`), token and admin checks (`guards.ts`), Cloudflare Access JWT (`access-jwt.ts`).
- `src/store/`: SQLite database (`db.ts`, `migrations/NNN_name.sql`), typed repository functions (`store.ts`), login envelopes (`logins-crypto.ts`).
- `src/cli.ts`: operator commands (`admin create`, `admin reset-2fa`, `rotate-login-key`, `backup-db`).
- `src/metrics.ts`: Prometheus counters and exposition.
- `src/egress/`, `src/policy.ts`, `src/audit.ts`: egress proxy, allowlist rules, audit file and JSON logs.
- `deploy/`: operator runbook, `backup.sh` (restic), `check-compose.ts` (`npm run check:compose`).
- `test/unit`, `test/integration` (`npm test`), `test/e2e` (smoke), `.github/` (CI, Trivy).

Logs are JSON lines on stdout (`{level,msg,profile,tool,ms}`), never arguments or secrets. The audit file (`AUDIT_FILE`) is separate.

## Gateway and runner

Two services, one image (`Dockerfile.gateway`), both `node` (uid 1000), read-only root filesystem, all capabilities dropped:

- **gateway**: MCP, admin UI, OAuth, egress proxies, `arb.db`. No Docker socket. On Linux, `secrets/login_key` must be readable by uid 1000.
- **runner**: the only service with `/var/run/docker.sock` (through `DOCKER_GID`, `group_add`), `network_mode: none`. Listens on `/run/arb-runner/runner.sock` (0600, in a 0700 directory on the `arb-runner` volume, mounted by these two services only). It starts at most `MAX_COMPUTERS` computers at once (default 4; ensures are serialized so the count holds). It accepts a profile id plus one op (`ensure`, `exec`, `stream`, `stop`, `remove`, `list`), never an image, mount, container name or free command line. Containers are created from the computer image (`IMAGE`, set by compose to `${ARB_PREFIX}-computer:dev`, built locally) with fixed settings (runtime, no network, no caps, read-only rootfs, `arb-egress` mounted read-only at the profile's subpath, profile volume). `exec` only runs the `agent-browser` calls the gateway makes (fixed flags) and four helpers (`base64`/`rm -f` of a screenshot, `cat` of the session file, and `node -e <HIT>` with `at <x> <y>` or `focus`: the fixed, read-only CDP script of Record mode, see [Record a playbook](#record-a-playbook)), under `timeout -k 5`. `stop`/`remove`/`list` only touch containers carrying the stack's label. A refused request gets `invalid request` and a `runner refused a request` warning in the runner's logs.
- Healthcheck: `node src/runner/server.ts check` (one `list` round trip). The gateway starts once the runner is healthy.

## State

One SQLite file, `${DATA_DIR}/arb.db` (compose: volume `arb-data`, mounted at `/data`), mode 0600, WAL, foreign keys on. Tables: `profiles` (allowlist), `logins` (one AES-256-GCM envelope per saved login, with the `key_id` of the key that sealed it, and the last admin test: `last_tested_at`, `last_result`), `leases` (token hash, expiry: they survive a restart), `step_up` (per admin session: when a second factor was last proven, failed attempts since), `handoffs`, `playbooks` (admin notes per profile, see [Playbooks](#playbooks)), `profile_headers` (one AES-256-GCM envelope per custom header, see [Custom headers](#custom-headers)), and Better Auth's tables (`user`, `account`, `session`, `twoFactor`, `verification`, `apikey`, `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `rateLimit`, ...). Every token is stored as its sha256 (OAuth access/refresh tokens, API keys, leases); TOTP secrets are encrypted with `BETTER_AUTH_SECRET`. Deleting a profile deletes its logins, headers, leases, handoffs and playbooks (foreign key cascade), and its OAuth tokens, consents, pending codes and API keys.

Migrations: `src/store/migrations/NNN_name.sql`, applied at startup in order, one transaction each; `PRAGMA user_version` holds the last one applied. Add a file, never edit an applied one. Lot 7b: `003` (`apikey.lastIp`), `004` (`step_up`), `005` (`logins.last_tested_at`, `last_result`). Lot 9: `006` (`handoffs`; ended ones are purged after 30 days). Lot 10c: `007` (`playbooks`). `008` (`profile_headers`). Better Auth's tables come from `002_better_auth.sql`, never from its own auto-migration; `002` also drops the Lot 3 `oauth_clients`, `oauth_tokens`, `settings` and `profiles.token_hash` (old tokens stop working, agents reconnect). Bumping `better-auth` = diff its schema (`npx @better-auth/cli generate`) and add a migration.

Database driver: `node:sqlite` (built into Node, no native dependency, no build stage). Evidence for Lot 4 (2026-11-21): `better-auth@1.7.27` (latest) depends on `@better-auth/kysely-adapter@1.7.27`, which ships a `NodeSqliteDialect` and picks it automatically when handed a `DatabaseSync`; `node:sqlite` runs without an experimental warning on Node 24.22.1 (SQLite 3.53.4) and Node 26.13.1 (SQLite 3.54.1). `better-sqlite3` would add a native build for nothing.

## Page output

`snapshot` and `get_text` return page content inside `<untrusted_page_content>`. The gateway's own signals come after it, as one JSON line, only when they apply: `{"matches": N}` when `contains` was given, `{"truncated": true, "total_chars": N}` when the text was cut at `max_chars` (N = length before the cut).

- `get_text {ref? | selector?, contains?, context?, max_chars?}`: `ref` or a CSS `selector` (`get text <css>`), not both (validation error); neither = `body`. `contains` keeps the lines that contain it (case-insensitive) with `context` lines around (0 to 10, default 2); windows that overlap or touch merge, blocks are separated by a `…` line; no match gives `matches: 0` and an empty body, not an error. Then the result is cut at `max_chars` (default 4,000, max 50,000).
- `snapshot {scope?, compact?, max_chars?}`: `snapshot -i`, plus `-c` unless `compact: false`, plus `-s <scope>` (a CSS selector: agent-browser 0.43 does not take a ref there). Cut at `max_chars` (default 8,000, max 50,000).
- **Breaking (Lot 10a)**: `get_text` used to return up to 50,000 characters; it now returns 4,000 unless `max_chars` says otherwise. The `truncated` line makes the cut visible. Diff snapshots (`--delta`) are not exposed: their baseline lives in the profile's browser session, not in the client's.

The filter and the cut are pure functions in `src/mcp/steps.ts` (`grep`, `clip`, `readOut`), shared with `run_steps`.

## run_steps

A known path in one call: `run_steps {steps: [...]}`, 1 to 20 steps, run in order by the gateway (not `agent-browser batch`), inside the same `wrap` as every tool (kill switch, lease, handoff pause, one audit line). Each step has one key:

| Step | agent-browser |
| --- | --- |
| `{open: url}` | `open <url>`, checked against the profile allowlist first (refused: `Domain not allowed...`) |
| `{login: site, if_needed?}` | the `login` tool's path (`fillLogin`, password on stdin); `if_needed`: `get count input[type=password]` first, skipped when 0 |
| `{click: L}`, `{fill: L, value}` | ref: `click @eN`, `fill @eN -- <value>`; else `find <kind> <v> click \| fill <value> [--name n] [--exact]` |
| `{press: key}`, `{back: true}` | `press <key>`, `back` |
| `{wait: {ms}}` | `wait <ms>`, 1 to 5,000 |
| `{wait: {text \| selector \| url \| load}}` | `wait --text t`, `wait <css>`, `wait --url <glob>`, `wait --load load\|domcontentloaded\|networkidle`, each with `--timeout <budget left - 0.5 s>` |
| `{get_text: {...}, keep?}`, `{snapshot: {...}, keep?}` | same params and mapping as the tools (`stepArgv` in `src/mcp/steps.ts`) |

Locator `L`: `{ref}` (stale after a navigation) `| {text} | {label} | {role, name?} | {placeholder} | {testid} | {css}` (`find first <css>`), with `exact: true` for a case-sensitive whole match (`--exact`; on `role` only with `name`, ignored on `testid`, `css`, `ref`). Never `wait --fn`, no screenshot, no `request_human`: those stay separate tools.

Measured on agent-browser 0.43.0 (2026-11-23, throwaway `arb-computer:dev` container): `text` matches a substring; `placeholder` did not match a substring; `role ... --name Go --exact` does not match `go`; `wait --text` is a case-sensitive substring; `wait --url` takes a glob that must match the whole URL (`**/page*`); `find ... fill` has no `--` separator, so a locator fill value cannot start with `-` (zod refuses it; use a ref). A client killed mid-wait leaves the daemon waiting (default 25 s) and queues the next command: hence the `--timeout` on waits.

Reply: one text block. First line, JSON: `{"ok": true, "ms"}` or `{"ok": false, "failed_at": i, "error", "ms"}` (`i` is the 0-based step index). On success, then the kept outputs (`keep: true`) and the last output, each in its `<untrusted_page_content>` envelope followed by `{"step": i, ...signals}`. On failure (`isError`), no outputs: one envelope with agent-browser's error (it can quote the page, e.g. `Names seen: "Go"`, so it is never outside the envelope) and `snapshot -i -c` cut at 2,000 characters. `error` is `step failed`, `budget`, or the gateway's own refusal (`Domain not allowed...`, `Unknown site...`, `Login URL is outside the allowlist`).

Budget: 18 s for the whole call (`limits.budgetMs` in `steps.ts`, mutable for tests only). A step does not start with under 1 s left. Each exec gets the budget left as its runner timeout (at least 1 s; `computers.exec`/`ab` take an optional `timeoutMs`, default 90 s), and coreutils `timeout` cuts it at the next whole second. A failure with under 1 s left is reported as `budget`. Not bounded by the budget: a `login` step (`fillLogin` unchanged, its own 90 s timeouts; the next step checks the budget again) and the failure snapshot (5 s on top).

Audit: the usual line plus `steps` (count) and, on failure, `failed_at`. Never a URL, locator, fill value or page text.

Deviations from the Lot 10 plan: the fill step's text is `value` (not `text`, which is a locator kind); errors carry the step index, 0-based; agent-browser's error text goes in the envelope, the `error` field is a fixed word; no outputs on failure, only the page snapshot.

## Playbooks

A playbook is a note the admin writes for one profile: how to do a known task on a site, often a `run_steps` recipe. The agent reads it with `playbook {name?}`: without `name`, the list `[{name, description}]` (description = first non-empty line, leading `#` stripped, 200 characters max); with `name`, the body exactly as written. Unknown name: an error listing the available names. `{placeholders}` in a recipe are for the agent to fill, by hand or through `run_playbook`.

`run_playbook {name, params?}` runs the playbook's first ```` ```json ```` block (`{"steps": [...]}` or `[...]`) as `run_steps`, in one call: each `{word}` inside a string is replaced by `params.word` (strings, 500 characters max). Filled steps then go through the same `Steps` check, allowlist and budget as `run_steps`, so `params` grant nothing `run_steps` does not. Refused before the browser: unknown playbook, no json block, invalid JSON, no steps, a placeholder without its param (`Missing params: a, b`). Same reply as `run_steps`; on failure the body of the playbook follows (`Playbook <name>:`), so the agent has the fallback without a second call. A profile token's description lists `name (description)` for each playbook. Browser tool: paused and queued like `run_steps`, audited as `run_playbook` with `steps` and `failed_at`, never the name or params. Why a tool: a turn costs ~6.5k input tokens (lot 10 bench), and `playbook` + `run_steps` is two.

`pb_<name>` (profile token only): each playbook with a usable recipe is also a root tool, its name with dashes as underscores (`check-quota` → `pb_check_quota`). Description: the playbook's description. Input: one required string (500 characters max) per `{placeholder}` of the recipe, in order of first use. A call is `run_playbook {name, params}`: same checks, reply, pause and queue, and the same audit line and metric (`run_playbook`, never the name). The point is discovery and typed params, not a turn (`run_playbook` is already one call). No tool for a playbook without a json block, with invalid JSON or without steps; 20 at most per profile, by name, the others through `run_playbook`; a name that maps to a `pb_` name already taken is skipped. The list is rebuilt on every request; a `pb_` tool called from a stale list (playbook deleted, renamed or without a recipe since) gets `pb_x: no such playbook any more (…). Call playbook for the list.` A `global` token gets no `pb_` tool: its tool list does not depend on a profile.

- Exposure: a profile token's `playbook` description lists the names (`Playbooks: none.` if empty; it can be stale within a session, the list call is authoritative). A `global` token gets them in `lease_profile`'s reply (`playbooks: [{name, description}]`) and passes `lease`.
- Trust: the body is admin-written, so it is returned as-is, not in an `<untrusted_page_content>` envelope. Saving or deleting one is a step-up action (see [Auth](#auth)).
- Limits: name is a slug like a profile id (lowercase letters, digits and dashes, 1 to 40); body 1 byte to 20 KB (UTF-8, also a `CHECK` in the table). One playbook per `(profile, name)`; saving an existing name replaces it.
- Not paused, not queued: `playbook` never touches the browser, so it works while a handoff is open and does not wait behind a running `run_steps` (`wrap` mode `direct`, shared with `request_human` and `handoff_status`).
- Audit: the agent's reads are the usual `playbook` line. Admin writes are `admin:playbook_create`, `admin:playbook_update`, `admin:playbook_delete`, with the profile as `agent`; never the name or the body.

Example, for a profile that holds an n8n Cloud login under the site `n8n-cloud` (name `check-quota`):

~~~markdown
# Check the executions quota of an n8n Cloud workspace

Fill {workspace} with the workspace name as shown on the dashboard (case-sensitive), then call run_steps with:

```json
{"steps": [
  {"open": "https://app.n8n.cloud/manage"},
  {"wait": {"load": "networkidle"}},
  {"login": "n8n-cloud", "if_needed": true},
  {"click": {"text": "{workspace}"}},
  {"wait": {"text": "Executions"}},
  {"get_text": {"contains": "executions"}, "keep": true}
]}
```

The kept get_text holds the "Executions: used / limit" line. If step 2 fails (failed_at 2), the login needs a human: call request_human.
~~~

### Record a playbook

Playbooks tab, **Record**: takes over the live view, and the gateway turns each gesture into a `run_steps` step and runs that step instead of the raw input, so what is recorded is what replays. The steps show in a Recording card on the Session tab.

- Click: the runner's `HIT` script (CDP, read-only) returns the accessibility chain of the element at the point, with how many elements of the page each locator kind matches (for `#id` and `tag[name=…]`, the page's own count for that css, so quirks mode's case-insensitive ids count). It needs a single tab: with several page targets it cannot tell which one the view shows, so it refuses (422, "N tabs open"). The locator is the first element of the chain that has one, and must match that element only: role + name, else the same with `exact: true`, else its placeholder, else css `#id`, else css `tag[name=…]`. An element whose locators all match several elements (two "Delete" buttons) gets none, since agent-browser would act on the first match. Text and generic wrappers are walked through; a landmark or container (main, form, list, table, dialog…) stops the walk. No locator: "No stable locator matching only this element" (422), and nothing is clicked.
- Typing is buffered in the page and sent as one `fill` of the focused field (same unique locator rule) on the next click or Enter, Tab, Escape (only these three keys are recorded, as `press`). A fill replaces the click that focused its field. In a password field (the focused element's `type` property, through shadow roots, or the `type` attribute in any case) the typed text is dropped, never sent, and the saved login whose URL has the page's origin is filled instead (`{login: <site>, if_needed: true}`, it submits the form, so no `press` follows); no such login: 422, save one in Logins first; several: the page asks which one (names and usernames only) and sends it back as `{login}`. The login step replaces the clicks and Tabs that led to it and the fill of its own username in the same form, nothing else (no form: the fill is kept). Default param names are distinct (`email`, `email_2`…); one name for two different values blocks Replay and Save.
- After a gesture that failed (lease refusal included), the focus may still be on the previous field: typing is off in the page (what was typed meanwhile is dropped) and `teach-type` answers 409 until a click or an `open` goes through, so a password never lands in that field. The page numbers the gestures that may move the focus (`seq`) and names the one its text follows (`after`): one the gateway did not run, or a focused field that is not the one clicked, is 409 too. Typing inside a frame: 422.
- The address bar records `open` (allowlist checked). "Add output" records `get_text` with a CSS selector and/or `contains` and shows the text.
- Tick **Param** on a fill to make its value a `{placeholder}` (name editable). **Replay** runs the draft through `run_playbook`'s path, with the typed values as params. **Save as playbook…** fills the form of the Playbooks tab: saving is the usual `playbook-save`, with its step-up. Add output, Replay and Save wait for the gestures before them and send the typing buffer first. The draft lives in the page only: Stop, Leave view or leaving the profile drops it, and a gesture still running then adds nothing.
- Not recorded: hover, drag, selection, right click, other keys, shortcuts, uploads, conditions; inside iframes and shadow DOM the hit test sees the frame or host only, and the counts do not look inside them. Refused while an agent holds the lease (409, checked when the gesture's turn comes in the profile's queue), like the live view input. Each call is audited `admin:teach-*`, never the typed text.

Learnings from the `run_steps` measurements, worth applying in any recipe: wait for `networkidle` before `login {if_needed: true}` (the password field may not be rendered yet, and the login would be skipped); prefer `text`, `label` or `role` + `name` locators over refs (stale after a navigation) and CSS (brittle); `keep: true` on every output the agent needs (only the last one is returned otherwise); `wait.text` is case-sensitive (`get_text.contains` is not); `wait.url` takes a glob over the whole URL (`**/manage*`, not `/manage`). The selectors above are illustrative, not checked against n8n Cloud.

## Custom headers

The admin can set HTTP headers per profile and per origin (Domains tab), e.g. a staging bypass token or a basic-auth `Authorization`. The browser sends them with every request to that origin (document, subresources, fetches) once the gateway opens a page there.

- Scope: one exact `https://host` origin (no path, port or http), on the profile's allowlist when saved. Removing the domain later keeps the header stored but unused (an open off the allowlist is refused anyway).
- Injection: every `open <url>` the gateway sends (the `open` tool, a `run_steps` open, the admin open) gets `--headers <json>` when the URL's origin has headers (agent-browser 0.43 scopes them to that origin and drops them when the browser closes). `login` on such an origin opens the login page first, then runs `auth login --no-navigate`, since `auth login` navigates without them.
- Gap: a click or redirect into the origin before any `open` of it in the current browser session sends no header. Open the origin first (a `run_steps` recipe can).
- Secrets: values are sealed with the login key (AAD: profile, origin, name), never returned to the admin UI, the agent or the audit log; only names are listed. Re-encrypted by `rotate-login-key`; they pin the key at startup like saved logins.
- Limits: name a token like `X-Bypass-Token` (64 characters max, stored lowercase); hop-by-hop and browser-owned names refused (`host`, `content-length`, `connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `expect`, `proxy-*`); value printable ASCII, no leading or trailing space, 2000 characters max; 4000 characters of JSON per origin. Saving an existing `(origin, name)` replaces it.

## Human handoff

An agent stuck on something only a person can do (captcha, 2FA code, consent screen, broken login) calls `request_human {reason, minutes}` (1 to 120, default 30). It gets back `{handoff, state, deadline, url, next}`: the `url` is the admin page link (`#/handoff/<id>`, on `PUBLIC_URL` with `ADMIN_PUBLIC=1`, else `http://localhost:18788`), which the agent relays to its user. It carries no secret: opening it still needs an admin session. The reason is stripped of control characters, capped at 500, and stored as untrusted text: escaped in the UI, never in logs, audit entries or metric labels. The browser must be running; one open handoff per profile.

- States: `pending` (waiting for the admin), `taken` (the admin took over), then one of `done`, `failed` (with the admin's note, required for failed), `expired` (deadline passed), `cancelled` (the agent's lease ended). Expired and cancelled are applied when the handoff is next read, and audited as `handoff:expired` / `handoff:cancelled`.
- While a handoff is open, the agent's browser tools fail with `Waiting for a human (<id>) until <deadline>. Call handoff_status.`; `handoff_status {wait_s}` (0 to 25) long-polls the caller's last handoff (`{state, note?, url?, next}`; another lease or token sees `none`). The lease is frozen until the deadline (it cannot expire under the human), then slides again; `lease_profile` skips profiles with an open handoff, and the idle reaper leaves them running.
- Admin side: a "Needs you" counter in the nav and the tab title, a pill on the profile row, and on the Session tab a banner quoting the agent ("Agent says: …") with Take over / Decline, then Done / Failed with a note for the agent. The deep link opens the profile with Take over focused; it never takes over by itself.
- Input under a lease: while an agent holds the lease and no handoff is `taken`, the live view WebSocket forwards only stream acks and control frames to the browser (no mouse, keyboard or other command), checked frame by frame; fragmented, unmasked or over-64 KiB client frames close it. Paste and on-screen login fill answer 409 under the same rule. Taking the handoff unlocks them; otherwise force release the lease.

## Auth

Better Auth `1.7.27` (pinned, with `@better-auth/oauth-provider`, `@better-auth/api-key`, `@better-auth/cimd`; `twoFactor` built in), on the same `arb.db`. Open security topics: [SECURITY.md](../SECURITY.md).

- **Agents, OAuth 2.1**: `/.well-known/oauth-protected-resource` points to the issuer `${PUBLIC_URL}/api/auth`. Dynamic client registration (or a CIMD client id URL), PKCE S256 only, access tokens `arb_at_` (1 h), refresh tokens `arb_rt_` (30 days, rotated). The admin signs in on `/login` (password + TOTP or a backup code) and picks on `/consent` which scope the client gets: `profile:<id>` or `global`. The consent page shows the client id, whether it is a self-registered DCR client ("unverified": its name is self-declared) or a CIMD client (name vouched for by its metadata URL's domain), how long ago it registered, and a note for loopback redirect URIs. Granting `global` to a DCR client takes a second, explicit confirmation behind a warning. Both pages work without JavaScript, and send `Referrer-Policy: same-origin` (under `no-referrer` a browser sends `Origin: null` on the form POST, which the Origin check refuses). Signups are disabled.
- **Agents, API keys**: `arb_k_...`, created in the admin UI with a scope (`profile:<id>` or `global`) and a mandatory expiry (30 days, 90 days, 1 year, or a date 1 to 365 days ahead), shown once. Send as `Authorization: Bearer` or `x-api-key`. The key list shows each key's expiry and last client IP (as normalized by `TRUST_PROXY`). Keys created before Lot 7b have no expiry: they keep working, are listed with `noExpiry: true`, and should be rotated (create a new one, revoke the old one).
- **Admin UI** (one HTML file, one script under a CSP nonce, no CDN): *Profiles* (list with state; per profile, tabs Session with live view, lease and "Extend 30 min", Logins with login test, Playbooks (editor with Form and Markdown tabs kept in sync: description, notes, steps one row each, placeholders, fallback; a step the form cannot show stays as JSON), Domains, Diagnostics, Settings), *Agent access* (OAuth clients and API keys; key dialog with mandatory expiry, key shown once), *Security* (step-up window, backup codes, `reset-2fa` command). A sensitive action that gets `401 {stepUp: true}` prompts for a code, then replays the action. Agent requests: see [Human handoff](#human-handoff).
- **Admin**: one admin per gateway, email + password (12 to 128 characters) + mandatory TOTP (or one of 10 single-use backup codes). Session cookie, 12 h. On the admin listener only, "Trust this device for 30 days" skips the TOTP step at sign-in (a `trust_device` cookie, rotated on each use); the public listener neither issues nor reads it. Sensitive actions (create or revoke a key or client, save or delete a login, a header or a playbook, change a profile's domains, delete a profile) need a second factor proven in the last 15 minutes (step-up): the sign-in TOTP counts, a trusted-device sign-in does not. Host and Origin checked on every call. Admin UI on `:18788` (localhost) only, unless `ADMIN_PUBLIC=1` (then also on `PUBLIC_URL`, behind Cloudflare Access: `ACCESS_AUD` and `ACCESS_TEAM` are required; the Access email must be the admin's). When `PUBLIC_URL` is https, the `:18788` listener uses its own Better Auth instance (same database and secret) with base URL `http://localhost:18788`, so its cookies carry no `Secure`/`__Secure-` prefix and still work through an SSH forward; the public listener's cookies are `Secure`. The Access JWKS is cached 1 h and refetched on an unknown key id (at most once a minute).
- **Limits** (stored in `rateLimit`, per client IP: `cf-connecting-ip` with `TRUST_PROXY=cloudflare`, else the TCP peer address): sign-in 5/min, TOTP 5/min (then 15 min lockout after 5 failures), consent 10/min, token 30/min. Client registration: 5/min per IP, 20/h and 1000 clients overall; clients never granted anything are purged after 24 h.
- `BETTER_AUTH_SECRET` (Docker secret `better_auth_secret`, at least 32 characters) signs cookies and encrypts TOTP secrets. Changing it signs everyone out and invalidates every TOTP enrolment (`admin reset-2fa`). `PUBLIC_URL` is Better Auth's base URL (`BETTER_AUTH_URL`).

### Admin

```sh
docker compose exec gateway node src/cli.ts admin create you@example.com   # password, then a TOTP code
docker compose exec gateway node src/cli.ts admin reset-2fa you@example.com # new password + new TOTP, sessions dropped
```

Both prompt for the password (hidden on a TTY, one line on stdin otherwise), print an `otpauth://` URI to add to an authenticator app, then ask for a code from the app to confirm. Once confirmed, they print 10 backup codes (`xxxxx-xxxxx`, one use each, stored encrypted). **The `otpauth://` URI and the backup codes are the only secrets the CLI ever prints**, once: store the codes offline, then clear the terminal. Nothing else (password, `BETTER_AUTH_SECRET`, keys) is ever output. 2FA enrolment is CLI-only (host access), never in the admin UI. A lost authenticator: sign in with a backup code, or `admin reset-2fa` from the host (new codes, old ones void).

### Admin API

JSON in and out (`content-type: application/json` on every POST), session cookie, admin listener only (or `PUBLIC_URL` behind Cloudflare Access with `ADMIN_PUBLIC=1`). Errors: `{error}`. `401 {error, stepUp: true}` = signed in but the step-up window is closed: POST `/api/step-up`, then retry.

| Call | Body | 2xx response |
| --- | --- | --- |
| `GET /api/session` | | `{email, stepUpRemainingS}` (0 = closed) |
| `POST /api/step-up` | `{code}` (TOTP) or `{backupCode}` | `{stepUpRemainingS: 900}`. Wrong code: 401 `{stepUp: true}`; 5 failures sign the session out; 429 after 5 per minute per IP |
| `GET /api/computers` | | `[{id, state, allow, logins, leasedUntil, lastCall, idleStopInS, viewers, handoff, ...}]` (`handoff`: `{id, state, reason, created, deadline}` while one is open, else null) |
| `GET /api/computers/:id` | | `{id, running, page, logins: [{site, url, username, lastTestedAt, lastResult}], headers: [{origin, name}], playbooks: [{name, body, updated, description}], cookies, storage, audit}` (`lastResult`: `ok`, `fail` or null) |
| `POST /api/profiles` | `{id, allow}` | 201 `{id}` |
| `POST /api/computers/:id/{start,stop,open,release}` | `{}` / `{url}` for open | `{started, port}`, `{stopped}`, `{opened}`, `{released}` |
| `POST /api/computers/:id/config` (step-up) | `{allow}` | `{allow}` |
| `POST /api/computers/:id/login-save` (step-up) | `{site, url, username, password}` | `{saved}` (clears the last test result) |
| `POST /api/computers/:id/login-delete` (step-up) | `{site}` | `{deleted}` |
| `POST /api/computers/:id/header-save` (step-up) | `{origin, name, value}` | `{saved: {origin, name}}` (replaces an existing name). Bad origin, name or value, over 4000 characters per origin: 400 |
| `POST /api/computers/:id/header-delete` (step-up) | `{origin, name}` | `{deleted}`. Unknown: 404 |
| `POST /api/computers/:id/playbook-save` (step-up) | `{name, body}` | `{saved, created}` (replaces an existing name). Bad name, empty or over-20 KB body: 400 |
| `POST /api/computers/:id/playbook-delete` (step-up) | `{name}` | `{deleted}`. Unknown: 404 |
| `POST /api/computers/:id/login-test` | `{site}` | `{ok, url}`: same fill as the agent's `login` tool; `ok` = form filled and submitted, `url` = where the browser ended up (judge success from it). 404 unknown site, 409 while an agent holds the lease |
| `POST /api/computers/:id/extend` | `{minutes}` (integer 1 to 120) | `{leasedUntil}` = now + minutes, or later if it already ends later (a handoff freezes it); the agent's next calls keep sliding by that duration. 404 without a live lease |
| `POST /api/computers/:id/handoff-take` | `{}` | `{state: "taken"}`. 409 without an open handoff |
| `POST /api/computers/:id/handoff-{done,fail}` | `{note}` (optional for done, required for fail; max 1000) | `{state}` (`done` or `failed`). 409 without an open handoff; 400 empty note on fail |
| `POST /api/computers/:id/teach-{click,type,press,open,read}` | `{x, y}` (CSS pixels) / `{text}` (1 to 500) or `{login}` (the pick) / `{key}` (`Enter`, `Tab`, `Escape`) / `{url}` / `{selector?, contains?}`; `seq` on click, press, open, `after` on type | `{step, field?, text?, user?, form?}`: the step run ([Record a playbook](#record-a-playbook)); `user` = the login's username, on a login step; `form` = the focused field's form node; or `{pick: [{site, username}]}` when several logins match. 400 bad input or a step `run_steps` would refuse, 409 while an agent holds the lease or (`teach-type`) after a click or typing that failed, 422 no locator matching only that element, several tabs, no login for a password field, or a browser error |
| `POST /api/computers/:id/teach-replay` | `{body, params?}` (body = a playbook text) | `{ok, text}`: the `run_steps` reply. 400 no recipe or a missing param |
| `POST /api/computers/:id/delete` (step-up) | `{}` | `{deleted}` |
| `GET /api/clients` | | `{oauth: [{id, name, createdAt, scopes, lastToken}], keys: [{id, name, start, scope, createdAt, lastRequest, lastIp, expiresAt, noExpiry}]}` |
| `POST /api/keys` (step-up) | `{name, scope, expiresIn: "30d"\|"90d"\|"1y"}` or `{name, scope, expiresAt: ISO date}` | 201 `{id, key, expiresAt}` (the key is shown once). Missing expiry or `never`: 400 |
| `POST /api/{keys,clients}/:id/revoke` (step-up) | `{}` | `{revoked}` |

Sign-in goes through Better Auth (`/api/auth/sign-in/email`, then `/api/auth/two-factor/verify-totp` or `verify-backup-code`, `{code, trustDevice}`); the admin page wraps them.

### Login key

`LOGIN_KEY_FILE` (default `/run/secrets/login_key`, the `login_key` Docker secret from `./secrets/login_key`): 32 random bytes, kept out of the data volume so a copy of `arb.db` alone exposes no password. At startup:
- saved logins or headers exist and the key is missing: the gateway refuses to start (restore the key, never create a new one);
- the key does not match the `key_id` of the saved logins or headers: refuses to start, naming the ids;
- no saved login or header and no key: creates one (0600) only if the path is writable, otherwise refuses with instructions. A Docker secret is read-only: create it yourself (command above).

Back up the key and `arb.db` separately: `arb.db` with `deploy/backup.sh` (restic, consistent `backup-db` snapshot), the key in a password manager (runbook, section 9).

### Operator commands

Run with the gateway stopped; they write `arb.db` and the key file, and print counts and ids only.

```sh
docker compose stop gateway
# The secret mount is read-only: rotate on the host file through a writable bind mount.
docker compose run --rm --no-deps -e LOGIN_KEY_FILE=/secrets/login_key -v "$PWD/secrets:/secrets" gateway node src/cli.ts rotate-login-key
docker compose start gateway
```

`rotate-login-key` writes a new key to `<key>.new`, re-encrypts every login and header in one transaction, then renames `<key>` to `<key>.old` and `<key>.new` to `<key>`. On failure nothing changes. Delete `<key>.old` once no backup of `arb.db` needs it. A crash between the commit and the renames leaves the live key in `<key>.new`: the startup error names the key id it expects.
