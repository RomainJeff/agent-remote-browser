# agent-remote-browser: open security topics

Known residual risks, accepted or not yet fixed. How the design works (isolation, runner, auth, step-up, leases): [docs/reference.md](docs/reference.md).

## Reporting a vulnerability

Report it privately through GitHub: **Security** tab of this repository, **Report a vulnerability**. Do not open a public issue or pull request for it. Include the commit, the setup (`compose.yaml` or tunnel) and the steps to reproduce. This is a personal project: reports are handled on a best-effort basis, and there is no bug bounty or paid reward. Risks already listed below are known; a report that changes their severity is still welcome.

Trust model: the public listener accepts untrusted OAuth clients, and MCP tokens delegate use of a browser with real sessions. Pages, tool arguments and browser output are untrusted. The operator, runner, Docker daemon and local machine are trusted. The gateway is trusted with the browsers and their data, not with the host.

## Browsers and saved logins

- **Malicious content on a trusted login site** (high). A saved login trusts the configured site, its scripts and the browser automation package.
- **Saved browser sessions on disk** (high). Profile volumes (`arb-profile-*`: cookies, sessions) are plaintext on the host disk, and so is a restored profile tar from a backup. Use encrypted host storage and protect backups.
- **Allowed origins see what the browser sees.** Public sites and scripts on an allowed origin can receive any data available to that browser. The egress proxy controls the upstream IP and port; it does not inspect encrypted traffic.
- **Private services on public addresses.** Egress refuses private and special-use destinations. A deployment that routes globally numbered addresses to private services needs its own routing policy.
- **`fill` accepts passwords.** Its description says never a password; nothing enforces it.
- **Untrusted page wrapping is a hint.** `<untrusted_page_content>` tells the model that page text is data, not instructions. It does not prevent prompt injection.

## Gateway and runner

- **Gateway compromise** gives the browsers and their data: drive any profile, read its pages and session file, use and decrypt its saved logins (`arb.db` and the login key are both in reach), control egress. It can also stop or delete any computer and profile volume of the stack, and hold all `MAX_COMPUTERS` slots to deny browsers to other agents. Beyond that, the runner's validation holds.
- **Runner compromise = host compromise.** It holds the Docker socket.
- **Runner auth is the socket's file mode.** Anything running as uid 1000 on the `arb-runner` volume, or as root on the host, counts as the gateway.

## Admin and agent auth

- **Stolen session cookie without step-up** can still read state, start and stop computers, open allowed URLs, watch and drive a browser through the live view (paste, copy), test or fill saved logins, and extend or release leases. It cannot mint credentials or change what an agent may reach.
- **Handoff reason is agent-written.** It is shown escaped and quoted, but it can mislead: an agent steered by a page can ask the human to "confirm a transfer". Read it as a request, not an instruction.
- **Handoff Done / Failed are not step-up gated.** A stolen session can end a request (and Take over unlocks live input on that profile until it ends).
- **Handoff link is relayed by the agent.** It carries no secret, but a manipulated agent can hand over another link instead: check the host before signing in.
- **TOTP replay** within its 30 s window, for sign-in and step-up.
- **Lease `extend` is not step-up gated** (bounded at 120 minutes from now; release is one click).
- **Backup codes** are as strong as where the admin keeps them.
- **API keys without expiry** created before Lot 7b keep working. They are flagged `noExpiry` in the admin list: rotate them.
- **Session tokens** are stored as is in `arb.db` (Better Auth), valid 12 h.
- **Login "Test"** proves the form was filled and submitted, not that the site accepted the password: check the final URL.
- **CIMD client fetching** is enabled but not exercised by the tests.
- **Consent profile choice** is held in memory for the duration of one request.
- **Shared OAuth budgets** (registration, sign-in rate limits) can be exhausted deliberately, delaying new connections.
- **Historical logs** written before the logging fix may contain sensitive arguments and errors: review them separately.

## Deployment

- **Forged client IP from the host.** With `TRUST_PROXY=cloudflare`, a local process or a container on the stack's network can reach the gateway directly and choose its `Cf-Connecting-IP`. Local processes are trusted; a shared host is not a supported deployment.
- **Reverse proxy on `compose.yaml`.** Every client shares the proxy's rate-limit budget: a stranger can slow the admin's sign-in or new client registrations (availability only).
- **Serialized `ensure`.** The runner starts containers one at a time so the cap holds: a slow start delays the others.
- **Cap disclosure.** The agent sees `Too many computers running (MAX_COMPUTERS=N)`. Other failures stay masked as `Browser operation failed`.
- **Stale browser images.** A browser container is recreated on image change only when the gateway starts or the profile is next used.
- **Leftover volumes.** Browser containers and volumes are created by the runner, not compose: `docker compose down -v` leaves them (cookies on disk). Uninstall removes them by label (runbook, Uninstall).
- **Cloudflare Access rules** in the runbook are documented, not tested against a live account. A missing rule fails closed.
- **Local Docker peers.** Native processes and containers with gateway network access remain trusted.

## Supply chain and operations

- **Digests do not update themselves.** Renovate opens the PRs, a human merges them. Until merged, base-image fixes are not deployed.
- **arm64 release image** is not scanned separately by Trivy.
- **Release images are selected by tag** in `.env`, not by digest: a re-pushed tag would be pulled (only this repository's workflow can push).
- **`/metrics` has no auth.** Anything that can reach port 18788 reads the counters. No profile id, token or URL is ever a label.
