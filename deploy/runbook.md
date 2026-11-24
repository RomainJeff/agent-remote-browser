# Operator runbook

How to run agent-remote-browser on one Linux host you control. Hosting-agnostic: any VM or bare-metal box that runs Docker. Commands assume the repository root as working directory and the default `ARB_PREFIX=arb` (containers `arb-*`, volumes `arb-*`). Open security topics: [SECURITY.md](../SECURITY.md).

## 1. Prerequisites

- **Linux x86_64 or arm64**, encrypted disk (browser profile volumes hold session cookies in clear), ~1 GB RAM per running browser (`MAX_COMPUTERS`, default 4) plus ~300 MB for the stack.
- **Docker Engine 27 or newer** (the runner speaks Engine API v1.47) and **Docker Compose 2.24 or newer** (`!reset`).

  ```sh
  docker version --format '{{.Server.Version}}'   # >= 27
  docker compose version                          # >= 2.24
  ```

- **gVisor (`runsc`)**, the sandbox runtime of the browser containers. The runner refuses to start without it. Debian/Ubuntu ([upstream instructions](https://gvisor.dev/docs/user_guide/install/)):

  ```sh
  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
  sudo apt-get update && sudo apt-get install -y runsc
  sudo runsc install -- --host-uds=open   # adds the runtime to /etc/docker/daemon.json
  sudo systemctl restart docker
  docker info --format '{{json .Runtimes}}' | grep -q host-uds=open && echo runsc ok
  ```

  `runsc install` writes this into `/etc/docker/daemon.json` (merge it by hand if you manage that file yourself):

  ```json
  { "runtimes": { "runsc": { "path": "/usr/bin/runsc", "runtimeArgs": ["--host-uds=open"] } } }
  ```

  `--host-uds=open` lets a sandboxed browser connect to a Unix socket created outside gVisor: its only network path is the gateway's egress socket, mounted read-only from `arb-egress`. Without it every browser call fails (`Browser operation failed`). It does not let the sandbox create sockets on the host.

- **Configuration**: `cp .env.example .env`, then set at least:

  ```sh
  SANDBOX_RUNTIME=runsc
  DOCKER_GID=$(stat -c %g /var/run/docker.sock)   # write the number, e.g. DOCKER_GID=988
  PUBLIC_URL=https://browser.example.com           # the URL agents reach; empty = local use only
  ```

  `ALLOW_NO_SANDBOX` stays empty in production (it exists for macOS development).

## 2. Secrets

Three files under `./secrets/`, mounted as Docker secrets (never environment variables, never in `.env`). The gateway runs as uid 1000, cloudflared as uid 65532: each file is readable by its reader only.

```sh
sudo install -d -m 700 secrets
sudo sh -c 'umask 077; head -c 32 /dev/urandom > secrets/login_key; openssl rand -base64 48 | tr -d "\n" > secrets/better_auth_secret'
sudo chown 1000:1000 secrets/login_key secrets/better_auth_secret
sudo chmod 400 secrets/login_key secrets/better_auth_secret
```

- `login_key`: 32 random bytes, encrypts saved logins. Losing it = losing every saved password. Back it up apart from the data volume.
- `better_auth_secret`: signs session cookies and encrypts TOTP secrets. Changing it signs everyone out and voids TOTP enrolments (`admin reset-2fa`).
- `cloudflared_token`: only with the tunnel (section 5). Paste it without echo and without shell history:

  ```sh
  read -rs TUNNEL_TOKEN          # paste, then Enter
  printf %s "$TUNNEL_TOKEN" | sudo sh -c 'umask 077; cat > secrets/cloudflared_token'; unset TUNNEL_TOKEN
  sudo chown 65532:65532 secrets/cloudflared_token && sudo chmod 400 secrets/cloudflared_token
  ```

## 3. Choose a compose file

| | `compose.yaml` | `compose.tunnel.yaml` |
| --- | --- | --- |
| MCP port 18787 | published on `${BIND_ADDR:-127.0.0.1}` | not published: Cloudflare named tunnel only |
| Admin port 18788 | published on `127.0.0.1`, always | not published (SSH forward, or `ADMIN_PUBLIC=1` behind Access) |
| TLS | yours (reverse proxy) | Cloudflare |
| Rate-limit key | TCP peer address | `Cf-Connecting-IP` (`TRUST_PROXY=cloudflare`) |
| Inbound firewall port | 443 on your proxy | none (outbound only) |

Pick **the tunnel** when the host should accept no inbound connection, or has no public IP. Pick **compose.yaml** for local use, a private network, or when you already run a TLS reverse proxy.

Every image is pinned by digest (`node` in the `Dockerfile`s, `alpine` in `deploy/backup.sh`, `cloudflared` in `compose.tunnel.yaml`). `npm run check:compose` (needs Node 24+) validates both setups and their exposure rules.

`compose.tunnel.yaml` is an override of `compose.yaml`: put `COMPOSE_FILE=compose.yaml:compose.tunnel.yaml` in `.env`, and every `docker compose` command of this runbook (and `deploy/backup.sh`) uses both files.

**Without a tunnel, remote agents**: keep `BIND_ADDR` empty and put a reverse proxy on the host, for example Caddy (automatic certificates):

```
browser.example.com {
	reverse_proxy 127.0.0.1:18787
}
```

Rate limits are then keyed on the proxy's address, so every client shares one budget (sign-in 5/min, client registration 5/min). `BIND_ADDR=0.0.0.0` publishes plain http on every interface and Docker's port publishing bypasses host firewalls such as ufw: use it only on a trusted network.

## 4. First boot

```sh
docker compose up -d --build                                  # with the tunnel: COMPOSE_FILE set in .env (section 3)
docker compose ps                                             # runner healthy, gateway up
docker compose exec gateway node src/cli.ts admin create you@example.com
```

`admin create` asks for a password (12 to 128 characters), prints an `otpauth://` URI (add it to an authenticator app), asks for a code to confirm, then prints 10 backup codes (one use each). Store the codes offline (password manager or paper), then clear the terminal: they are never shown again. One admin per gateway; signups are disabled. 2FA enrolment happens only here, on the host: the admin UI cannot enrol or reset a second factor.

Test key from the host, without the admin UI (e.g. for a bench or an agent the operator lets run it): the key goes to a 0600 file, never to the terminal, and expires after 1 day unless `[days]` says otherwise (up to 365). `--global` instead of `<profile>` makes a global key (all profiles, like the admin UI's). The gateway container is read-only, so write it to a fresh directory in its `/tmp` and copy it out; the key lands in a private temp file, moved into place only on success:

```bash
f=$(mktemp ~/.arb-test-key.XXXXXX) && docker compose exec -T gateway sh -c 'd=$(mktemp -d) && node src/cli.ts key create <profile> "$d/k" >&2 && cat "$d/k"; s=$?; rm -rf "$d"; exit $s' > "$f" && mv "$f" ~/.arb-test-key || { s=$?; rm -f "$f"; (exit $s); }
docker compose exec gateway node src/cli.ts key revoke <id>      # id printed by key create; also revocable in the admin UI
```

Readiness: `curl -fsS http://127.0.0.1:18787/readyz` (without tunnel), or with the tunnel `docker compose exec gateway node -e "fetch('http://127.0.0.1:18787/readyz').then(r => process.exit(r.ok ? 0 : 1))"`.

### Reaching the admin UI

- **Same machine**: http://127.0.0.1:18788.
- **Remote host, `compose.yaml`**: `ssh -L 18788:127.0.0.1:18788 you@host`, then http://localhost:18788 on your machine.
- **Remote host, `compose.tunnel.yaml`** (nothing published): forward to the gateway's container address.

  ```sh
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' arb-gateway-1   # on the host, e.g. 172.20.0.3
  ssh -L 18788:172.20.0.3:18788 you@host                                                     # on your machine
  ```

  Then http://localhost:18788. The address changes when the container is recreated.

- **Public admin**: `ADMIN_PUBLIC=1` serves the admin UI on `PUBLIC_URL` too. The gateway refuses to start unless `ACCESS_AUD` and `ACCESS_TEAM` are set, and then checks the Cloudflare Access token on every admin request (section 5).

In the admin UI: create a profile (id + allowed domains), save logins for it (and "Test" them), create API keys (expiry required: 30 days, 90 days, 1 year or a date), revoke connected clients, extend or release an agent's lease, watch a browser live.

Sign-in: password, then a TOTP code or a backup code. "Trust this device for 30 days" (admin listener only) skips the code at the next sign-ins from this browser. Sensitive actions (keys, clients, logins, domains, profile deletion) ask for a fresh code when the last one is older than 15 minutes; five wrong codes in a row sign the session out.

## 5. Cloudflare named tunnel

In the Cloudflare dashboard (Zero Trust, Networks, Tunnels):

1. Create a tunnel of type **Cloudflared**, name it, and copy the token from the install command it shows (`cloudflared ... --token <TOKEN>`). Store it as `secrets/cloudflared_token` (section 2).
2. Add a **public hostname** to the tunnel, e.g. `browser.example.com`, service **HTTP**, URL **`gateway:18787`**. The hostname must be on a zone of your account.
3. Set `PUBLIC_URL=https://browser.example.com` in `.env` and `COMPOSE_FILE=compose.yaml:compose.tunnel.yaml`, then start `docker compose up -d --build`. The gateway runs with `NODE_ENV=production` there: it refuses an empty `PUBLIC_URL` and quick-tunnel hostnames.
4. Check: `curl -fsS https://browser.example.com/healthz` prints `ok`. `docker compose logs cloudflared` shows the registered connections.

No route to `gateway:18788` is needed: the admin port is never put on the tunnel.

**Optional, public admin behind Cloudflare Access** (Zero Trust, Access, Applications):

1. Self-hosted application **arb admin**, policy **Allow**, include the admin's email only, with these destinations on `browser.example.com`: the whole hostname, plus the paths `api/auth/sign-in`, `api/auth/two-factor`, `api/auth/get-session` and `api/auth/sign-out`. Copy its **Application Audience (AUD) tag**.
2. Self-hosted application **arb agents** on the same hostname with the paths `mcp`, `api/auth`, `.well-known`, `login`, `consent`, policy action **Bypass**, include Everyone. The more specific paths win, so agents and OAuth servers (Notion's token calls) are not stopped by Access; `/login` and `/consent` stay protected by password + TOTP.
3. `.env`: `ADMIN_PUBLIC=1`, `ACCESS_AUD=<AUD tag>`, `ACCESS_TEAM=<team>` (from `<team>.cloudflareaccess.com`). Restart the gateway. The Access email must be the admin's.

The four `api/auth/...` paths in step 1 are the admin page's own sign-in calls. Without them, the `api/auth` Bypass covers them: Cloudflare sends no Access token there, and the admin sign-in fails with `forbidden`. Agents never call them directly (the public listener refuses them), so protecting them does not affect OAuth.

The gateway verifies the `Cf-Access-Jwt-Assertion` itself: an admin path reached without Access (a missing path rule) is refused, not opened.

Check from outside: `/`, `/healthz` and the four admin paths redirect (302) to `<team>.cloudflareaccess.com`; `/mcp` answers 401 from the gateway, and `/.well-known/oauth-authorization-server` and `/login` answer 200. `/healthz` is behind Access here: add `healthz` to the **arb agents** paths if an outside monitor needs it.

## 6. Connect an agent

Agents connect to `${PUBLIC_URL}/mcp` (Streamable HTTP).

- **OAuth 2.1** (Notion, Claude, any MCP client with OAuth): add the MCP server URL in the client. It registers itself (DCR), sends you to `/login` (admin password + TOTP), then `/consent`, where you pick the scope: `profile:<id>` (that browser only) or `global` (profile management). Revoke under "Connected clients".
- **API key** (scripts, clients without OAuth): admin UI, API keys, create with a scope. The key `arb_k_...` is shown once. Send it as `Authorization: Bearer arb_k_...` or `x-api-key`.

Check end to end from a checkout with Node 24+: `GATEWAY=https://browser.example.com/mcp TOKEN=arb_k_... npm run smoke`, or `TOKEN=arb_k_... npm run smoke` against a local gateway.

## 7. Day-2 operations

**Logs**: JSON lines on stdout, operation metadata only (never arguments or secrets).

```sh
docker compose logs -f gateway runner
docker compose exec gateway tail -f /data/audit.jsonl      # who did what (agent, tool, ok, duration), kept in the data volume
```

**Metrics**: `curl -s 127.0.0.1:18788/metrics` (Prometheus text: requests, tool calls by tool and outcome, auth failures, egress denials, runner up, computers running, active leases; docs/reference.md, Metrics). Admin listener only, so a Prometheus on the same host scrapes `127.0.0.1:18788`; a remote one goes through the same SSH forward as the admin UI. Worth an alert: `arb_runner_up == 0`, a jump in `arb_auth_failures_total` or `arb_egress_denied_total`.

**Kill switch**: every tool call is refused while the file exists; browsers stay up.

```sh
docker compose exec gateway touch /data/KILL       # on
docker compose exec gateway rm /data/KILL          # off
```

To stop everything instead: `docker compose stop`, then stop the browsers (they are not compose services): `docker ps -q --filter label=arb-computer | xargs -r docker stop`.

**Upgrade**:

```sh
git fetch && git checkout <commit>
deploy/backup.sh                                  # restic snapshot of arb.db first (section 9)
docker compose up -d --build                      # migrations run at gateway start, forward only
```

Browser containers need no manual step: their spec label hashes the computer image ID, so the gateway recreates running ones at start and the others at their next use (profile volumes are kept). Image digests change only through a commit (pinned in the `Dockerfile`s and `compose.tunnel.yaml`, bumped by Renovate PRs), so an upgrade is reviewable and a rollback is `git checkout <previous commit>` plus the same commands. A rollback across a database migration also needs the `arb.db` copy taken before the upgrade (section 9, Restore).

**Rotate the login key** (gateway stopped; the secret mount is read-only, so the CLI writes the host file through a bind mount of `secrets/`, which uid 1000 must be able to write for the duration):

```sh
docker compose stop gateway
sudo chown 1000 secrets
docker compose run --rm --no-deps -e LOGIN_KEY_FILE=/secrets/login_key -v "$PWD/secrets:/secrets" gateway node src/cli.ts rotate-login-key
sudo chown root secrets
docker compose start gateway
```

The previous key is kept as `secrets/login_key.old`: delete it once no `arb.db` backup needs it.

**Lost authenticator**: sign in with a backup code, then on the host `docker compose exec gateway node src/cli.ts admin reset-2fa you@example.com` (new password, TOTP and backup codes; old ones void, sessions dropped). No backup code left: the same command, from the host.

**API keys without expiry** (created before Lot 7b): they still work, and the admin list flags them `noExpiry`. Rotate each one: create a new key for the same scope, switch the agent to it, revoke the old one. A key's last IP shows in the same list: an address you do not recognise = revoke.

**Saved login looks broken**: "Test" on the login row fills the form like the agent would and shows the page it ended on (still on the login page = wrong password or a changed form). Refused while an agent holds the profile: release the lease first, or wait.

**Write a playbook by showing it**: Playbooks tab, Record. Do the task in the live view (click, type, Enter; the typed text reaches the page on the next click or Enter), add the output, tick the values the agent should pass as params, Replay, then Save as playbook… and give it a name and a first line. A password field needs a saved login for that site first. Release the agent's lease before recording.

**Backups**: section 9.

## 8. Uninstall

```sh
docker compose down                                                # services, networks
docker ps -aq --filter label=arb-computer | xargs -r docker rm -f   # browser containers: created by the runner, not by compose
docker volume ls -q --filter label=arb-computer | xargs -r docker volume rm   # profile volumes (cookies)
docker volume rm arb-data arb-egress arb-runner                     # database, egress sockets, runner socket
docker image rm arb-computer:dev arb-gateway:dev                    # with another ARB_PREFIX: <prefix>-computer:dev, <prefix>-gateway:dev
sudo rm -rf secrets
```

`docker compose down -v` alone leaves the browser containers and the volumes they use. Every name and label starts with `ARB_PREFIX`: adjust it if you changed the prefix, and never widen these filters (other stacks may share the daemon). Removing `arb-data` and `secrets/` is irreversible: keep a backup if the saved logins may be needed again.

## 9. Backups and restore

Two things to keep, never in the same place: the data (`arb.db`, optionally the profile volumes) and the keys (`secrets/login_key`, `secrets/better_auth_secret`). `arb.db` holds the saved passwords encrypted with the login key: one leak of both = every password.

**Data, with restic** (`deploy/backup.sh`, daily from cron). It takes a consistent snapshot with `cli.ts backup-db` while the gateway runs (`VACUUM INTO`: never copy `arb.db` and its `-wal` by hand), streams it out of the gateway, and with `BACKUP_PROFILES=1` also tars every `arb-profile-*` volume (logged-in sessions: without them, agents log in again from the saved logins). Then `restic forget --keep-daily 30 --prune`.

```sh
sudo apt install restic
restic -r s3:https://<endpoint>/<bucket>/arb init            # once; password into /root/.arb-restic (0600)
RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/arb RESTIC_PASSWORD_FILE=/root/.arb-restic BACKUP_PROFILES=1 deploy/backup.sh
```

**Keys, by hand, elsewhere**: `secrets/login_key`, `secrets/better_auth_secret` and the restic password go into the team password manager (`base64 < secrets/login_key` for the binary key), not into restic and not on the backup host. Again after `rotate-login-key`: snapshots older than the rotation need `login_key.old`, so keep it there until they expire (30 days). Without the login key a restored `arb.db` has profiles but no usable saved passwords; without the Better Auth secret, sessions and TOTP are lost (`admin reset-2fa` recovers).

**Restore drill** (quarterly, and after any change to this procedure). It touches nothing live: the snapshot is opened in a throw-away gateway container with the current key, which checks the key id, runs the migrations and an integrity check, and prints the counts to compare with the admin UI.

```sh
umask 077
restic snapshots --tag arb
restic dump --tag arb latest /var/tmp/arb-backup/arb.db > /var/tmp/arb.db
docker compose run --rm --no-deps -T -e DATA_DIR=/tmp/drill gateway \
  sh -c 'mkdir /tmp/drill && cat > /tmp/drill/arb.db && node src/cli.ts backup-db /tmp/check.db' < /var/tmp/arb.db
rm /var/tmp/arb.db
```

**Restore for real** (lost or corrupt volume, rollback across a migration): same `restic dump`, then, gateway stopped, the file replaces `arb.db` and the stale `-wal`/`-shm` go away:

```sh
docker compose stop gateway
docker compose run --rm --no-deps -T gateway \
  sh -c 'cat > /data/arb.db.new && rm -f /data/arb.db-wal /data/arb.db-shm && mv /data/arb.db.new /data/arb.db && chmod 600 /data/arb.db' < /var/tmp/arb.db
docker compose start gateway                      # refuses to start if secrets/login_key is not the key of this arb.db
```

A profile volume (stop that browser first, the volume keeps its label so uninstall and backups still find it):

```sh
docker volume create --label arb-computer=<id> arb-profile-<id>
restic dump --tag arb latest /var/tmp/arb-backup/profiles/arb-profile-<id>.tar \
  | docker run --rm -i --network none -v arb-profile-<id>:/v alpine:3.22 tar -C /v -xpf -
```

CI (`.github/workflows/ci.yml`, e2e job) runs this backup and the real restore on every push, against a throw-away stack.
