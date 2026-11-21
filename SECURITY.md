# Agent Computer security boundaries

The public listener accepts untrusted OAuth clients. MCP tokens delegate use of a browser with real sessions. Pages, tool arguments and browser output are untrusted. The operator, gateway, Docker daemon and local machine are trusted.

| Finding | Severity × effort | Disposition |
| --- | --- | --- |
| Gateway socket grants host control | Critical × high | Residual. Container creation with arbitrary mounts is sufficient for host control. An endpoint-only socket proxy still permits this. A dedicated VM or a validating broker is needed. |
| Browser access to LAN, metadata or other profiles | High × high | Fixed for private and special-use destinations. Docker network mode is none. A per-profile Unix socket accepts allowed domains on ports 80/443 and connects to a checked IPv4 address. Deployments routing globally numbered addresses to private services need additional routing policy. |
| Cross-origin admin writes and WebSocket access | High × low | Fixed. Require same-origin browser requests, loopback Host and JSON writes. |
| Clear saved passwords | High × medium | Fixed. Encrypt and authenticate credentials with a separately mounted key. |
| Sensitive request arguments and errors in logs | High × low | Fixed for new entries. Record operation metadata only. Historical logs require separate operator review. |
| Public registration and consent abuse | Medium × low | Fixed with gateway-wide budgets. Bound registration, consent attempts and pending grants. |
| Malicious content on a trusted login site | High × high | Residual. A saved login trusts the configured site, its scripts and the browser automation package. |
| Saved browser sessions and host backups | High × medium | Residual. Use encrypted host storage and protect backups. |


Authentication remains local-machine trust for admin and bearer-token trust for MCP. Local native processes and Docker peers with gateway network access remain trusted. Shared OAuth budgets can be exhausted deliberately, delaying new connections. Public sites and scripts on an allowed origin can still receive data available to that browser. A CONNECT proxy controls the upstream IP and port, while the browser validates TLS. It does not inspect encrypted application traffic.
