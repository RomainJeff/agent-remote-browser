# Operator runbook

How to run agent-remote-browser on one Linux host you control. Hosting-agnostic: any VM or bare-metal box that runs Docker. Commands assume the repository root as working directory and the default `ARB_PREFIX=arb` (containers `arb-*`, volumes `arb-*`). Threat model: [SECURITY.md](../SECURITY.md).

## 1. Prerequisites

- **Linux x86_64 or arm64**, encrypted disk (browser profile volumes hold session cookies in clear), ~1 GB RAM per running browser (`MAX_COMPUTERS`, default 4) plus ~300 MB for the stack.
- **Docker Engine 27 or newer** (the runner speaks Engine API v1.47) and **Docker Compose 2.24 or newer** (`include`, `!reset`).

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
  sudo runsc install            # adds the runtime to /etc/docker/daemon.json
  sudo systemctl restart docker
  docker info --format '{{json .Runtimes}}' | grep -q runsc && echo runsc ok
  ```

  `runsc install` writes this into `/etc/docker/daemon.json` (merge it by hand if you manage that file yourself):

  ```json
  { "runtimes": { "runsc": { "path": "/usr/bin/runsc" } } }
  ```

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

Every image is pinned by digest (`node`, `alpine` in the source; `cloudflared` in `compose.tunnel.yaml`). `npm run check:compose` (needs Node 24+) validates both files and their exposure rules.

**Without a tunnel, remote agents**: keep `BIND_ADDR` empty and put a reverse proxy on the host, for example Caddy (automatic certificates):

```
browser.example.com {
	reverse_proxy 127.0.0.1:18787
}
```

Rate limits are then keyed on the proxy's address, so every client shares one budget (sign-in 5/min, client registration 5/min). `BIND_ADDR=0.0.0.0` publishes plain http on every interface and Docker's port publishing bypasses host firewalls such as ufw: use it only on a trusted network.

## 4. First boot

```sh
docker compose up -d --build                                  # or: docker compose -f compose.tunnel.yaml up -d --build
docker compose ps                                             # runner healthy, gateway up
docker compose exec gateway node src/cli.ts admin create you@example.com
```

`admin create` asks for a password (12 to 128 characters), prints an `otpauth://` URI (add it to an authenticator app, then clear the terminal), and asks for a code to confirm. One admin per gateway; signups are disabled.

With `compose.tunnel.yaml`, add `-f compose.tunnel.yaml` to every `docker compose` command of this runbook.

Readiness: `curl -fsS http://127.0.0.1:18787/readyz` (without tunnel), or `docker compose -f compose.tunnel.yaml exec gateway node -e "fetch('http://127.0.0.1:18787/readyz').then(r => process.exit(r.ok ? 0 : 1))"`.

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

In the admin UI: create a profile (id + allowed domains), save logins for it, create API keys, revoke connected clients, watch a browser live.

## 5. Cloudflare named tunnel

In the Cloudflare dashboard (Zero Trust, Networks, Tunnels):

1. Create a tunnel of type **Cloudflared**, name it, and copy the token from the install command it shows (`cloudflared ... --token <TOKEN>`). Store it as `secrets/cloudflared_token` (section 2).
2. Add a **public hostname** to the tunnel, e.g. `browser.example.com`, service **HTTP**, URL **`gateway:18787`**. The hostname must be on a zone of your account.
3. Set `PUBLIC_URL=https://browser.example.com` in `.env` and start `docker compose -f compose.tunnel.yaml up -d --build`. The gateway runs with `NODE_ENV=production` there: it refuses an empty `PUBLIC_URL` and quick-tunnel hostnames.
4. Check: `curl -fsS https://browser.example.com/healthz` prints `ok`. `docker compose -f compose.tunnel.yaml logs cloudflared` shows the registered connections.

No route to `gateway:18788` is needed: the admin port is never put on the tunnel.

**Optional, public admin behind Cloudflare Access** (Zero Trust, Access, Applications):

1. Self-hosted application **arb admin** on `browser.example.com` (whole hostname), policy **Allow**, include the admin's email only. Copy its **Application Audience (AUD) tag**.
2. Self-hosted application **arb agents** on the same hostname with the paths `mcp`, `api/auth`, `.well-known`, `login`, `consent`, policy action **Bypass**, include Everyone. The more specific paths win, so agents and OAuth servers (Notion's token calls) are not stopped by Access; `/login` and `/consent` stay protected by password + TOTP.
3. `.env`: `ADMIN_PUBLIC=1`, `ACCESS_AUD=<AUD tag>`, `ACCESS_TEAM=<team>` (from `<team>.cloudflareaccess.com`). Restart the gateway. The Access email must be the admin's.

The gateway verifies the `Cf-Access-Jwt-Assertion` itself: an admin path reached without Access (a missing path rule) is refused, not opened.

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

**Kill switch**: every tool call is refused while the file exists; browsers stay up.

```sh
docker compose exec gateway touch /data/KILL       # on
docker compose exec gateway rm /data/KILL          # off
```

To stop everything instead: `docker compose stop`, then stop the browsers (they are not compose services): `docker ps -q --filter label=arb-computer | xargs -r docker stop`.

**Upgrade**:

```sh
git fetch && git checkout <release commit or tag>
docker compose exec -T gateway node src/cli.ts backup-db /tmp/pre-upgrade.db && docker compose cp gateway:/tmp/pre-upgrade.db ./pre-upgrade.db
docker compose up -d --build                      # migrations run at gateway start, forward only
```

With released images (GHCR, built by `release.yml` on a `v*` tag), set `ARB_IMAGE_REPO=ghcr.io/romainjeff/agent-remote-browser` and `ARB_IMAGE_TAG=<tag>` in `.env`, and replace the last line with `docker compose pull && docker compose up -d --no-build`. The checkout still matters: it brings the compose files that match the images. The package is private unless made public in its GitHub settings: `docker login ghcr.io` first, with a token that has `read:packages`.

Browser containers need no manual step: their spec label hashes the computer image ID, so the gateway recreates running ones at start and the others at their next use (profile volumes are kept). Image digests change only through a commit (pinned in the `Dockerfile`s and `compose.tunnel.yaml`, bumped by Renovate PRs), so an upgrade is reviewable and a rollback is `git checkout <previous commit>` plus the same commands. A rollback across a database migration also needs the `arb.db` copy taken before the upgrade (section 10, Restore).

**Rotate the login key** (gateway stopped; the secret mount is read-only, so the CLI writes the host file through a bind mount of `secrets/`, which uid 1000 must be able to write for the duration):

```sh
docker compose stop gateway
sudo chown 1000 secrets
docker compose run --rm --no-deps -e LOGIN_KEY_FILE=/secrets/login_key -v "$PWD/secrets:/secrets" gateway node src/cli.ts rotate-login-key
sudo chown root secrets
docker compose start gateway
```

The previous key is kept as `secrets/login_key.old`: delete it once no `arb.db` backup needs it.

**Lost authenticator**: `docker compose exec gateway node src/cli.ts admin reset-2fa you@example.com` (new password and TOTP, sessions dropped).

**Backups**: `arb.db` (volume `arb-data`), `secrets/login_key` and `secrets/better_auth_secret`, stored apart from each other. Automated backups and restore drills come with Lot 7; until then, stop the gateway and copy the volume and the key by hand.

## 8. Migrating from the POC

`migrate-from-poc` imports the POC's profiles, allowlists and saved logins, re-encrypted with the current key, in one transaction; then the profile volumes (`ac-profile-<id>` to `arb-profile-<id>`) are copied. POC tokens are not imported: agents reconnect through OAuth or get an API key. Mount the POC's `state.json` and `login.key` read-only into a one-off container, never copy them into this repository:

```sh
P="-v /path/to/poc/state.json:/poc/state.json:ro -v /path/to/poc/login.key:/poc/login.key:ro"
docker compose run --rm --no-deps $P gateway node src/cli.ts migrate-from-poc /poc/state.json /poc/login.key   # dry run
```

The dry run prints the counts, the ids, and the host commands that would copy each volume. Then pick one way to copy the volumes:

- **`ALLOW_POC_MIGRATION=1`, the runner copies** (it picks the source `ac-profile-<id>` itself and never overwrites a target):

  ```sh
  ALLOW_POC_MIGRATION=1 docker compose up -d runner      # runner recreated with copyVolume enabled
  docker compose stop gateway
  docker compose run --rm --no-deps $P gateway node src/cli.ts migrate-from-poc /poc/state.json /poc/login.key --apply
  docker compose up -d                                   # flag unset again: runner recreated without it
  ```

- **Flag left off, you copy**: run `--apply` with the gateway stopped (the profiles and logins are imported; each volume copy is reported as failed, refused by the runner, and the command exits 1), then run the `docker volume create` / `docker run ... cp -a` lines printed by the dry run yourself on the host, and `docker compose start gateway`.

The second way never gives the gateway a path to the POC's cookies, even for the duration of the migration. Leave the POC stack running until the agents work on the new one.

## 9. Uninstall

```sh
docker compose down                                                # services, networks (-f compose.tunnel.yaml if used)
docker ps -aq --filter label=arb-computer | xargs -r docker rm -f   # browser containers: created by the runner, not by compose
docker volume ls -q --filter label=arb-computer | xargs -r docker volume rm   # profile volumes (cookies)
docker volume rm arb-data arb-egress arb-runner                     # database, egress sockets, runner socket
docker image rm arb-computer:dev arb-gateway:dev                    # or the ghcr.io/... images if ARB_IMAGE_REPO is set
sudo rm -rf secrets
```

`docker compose down -v` alone leaves the browser containers and the volumes they use. Every name and label starts with `ARB_PREFIX`: adjust it if you changed the prefix, and never widen these filters (other stacks may share the daemon). Removing `arb-data` and `secrets/` is irreversible: keep a backup if the saved logins may be needed again.
