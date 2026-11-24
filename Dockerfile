# One image = one agent "computer": headless Chromium + agent-browser, nothing else.
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9

# ponytail: Debian chromium (works on arm64 + amd64); Chrome for Testing has no linux-arm64 build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ponytail: version pinned on purpose, upgrade deliberately (API moves fast)
ARG AB_VERSION=0.43.0
RUN npm i -g agent-browser@${AB_VERSION} && npm cache clean --force \
 && useradd -m -u 10001 agent && mkdir -p /home/agent/.agent-browser && chown -R agent /home/agent

ENV HOME=/home/agent \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_NO_VERSION_CHECK=1
USER agent
WORKDIR /home/agent
# Container idles; the gateway drives it with `docker exec ... agent-browser <cmd>`.
CMD ["sleep", "infinity"]
COPY chromium-policy.json /etc/chromium/policies/managed/agent-remote-browser.json
