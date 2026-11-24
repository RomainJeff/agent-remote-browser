#!/usr/bin/env bash
# check-quota.sh, through `codex exec` instead of `claude -p`: same env, same summary line in bench/results.jsonl.
#   ARB_MCP_URL=http://127.0.0.1:18787/mcp ARB_TOKEN=arb_k_... PROMPT='...' bench/codex-quota.sh <label>
# The ARB server comes from -c overrides; the key stays in the environment (bearer_token_env_var), never in
# ~/.codex/config.toml, argv or output. --ignore-user-config: no other MCP server, plugin or instruction in the measure
# (auth still comes from ~/.codex). Input tokens = Codex's input_tokens (cached ones included), Codex's own tools and
# system prompt included: not comparable 1:1 with claude -p. ms = wall time of the codex process.
set -euo pipefail
label=${1:?usage: $0 <label>}
: "${ARB_MCP_URL:?set ARB_MCP_URL}" "${ARB_TOKEN:?set ARB_TOKEN}" "${PROMPT:?set PROMPT}"
export ARB_TOKEN
N=${N:-3}
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
now() { python3 -c 'import time; print(int(time.time() * 1000))'; }

runs=()
for i in $(seq "$N"); do
  t0=$(now)
  (cd "$tmp" && codex exec --ignore-user-config --skip-git-repo-check --ephemeral --json -s read-only \
    -c "mcp_servers.arb.url=\"$ARB_MCP_URL\"" -c 'mcp_servers.arb.bearer_token_env_var="ARB_TOKEN"' \
    -c 'mcp_servers.arb.default_tools_approval_mode="approve"' "$PROMPT" < /dev/null) > "$tmp/run$i.jsonl" 2> /dev/null
  ms=$(( $(now) - t0 ))
  r=$(jq -s --argjson ms "$ms" '[.[] | select(.type == "item.completed" and .item.type == "mcp_tool_call") | .item] as $calls | {
    input_tokens: (last(.[] | select(.type == "turn.completed")).usage.input_tokens),
    cached_input_tokens: (last(.[] | select(.type == "turn.completed")).usage.cached_input_tokens),
    tool_use: ($calls | length),
    tools: ($calls | map(.tool)),
    browser_ms: ($calls | map(.result.content[0].text? // "" | split("\n")[0] | fromjson? | .ms? // empty) | add),
    ms: $ms,
    ok: (any(.[]; .type == "turn.completed")),
    answer: (last(.[] | select(.type == "item.completed" and .item.type == "agent_message")).item.text // "" | .[0:200])}' "$tmp/run$i.jsonl")
  echo "run $i: $(jq -c . <<<"$r")"
  runs+=("$r")
done

printf '%s\n' "${runs[@]}" | jq -s -c --arg label "$label" --arg at "$(date -u +%FT%TZ)" --arg commit "${COMMIT:-$(git -C "$here" rev-parse --short HEAD)}" '
  def median: sort | .[length / 2 | floor];
  {label: $label, client: "codex exec", at: $at, commit: $commit, n: length, ok: (map(select(.ok)) | length),
   median_input_tokens: (map(.input_tokens) | median), median_tool_use: (map(.tool_use) | median), median_ms: (map(.ms) | median),
   median_browser_ms: (map(.browser_ms // empty) | if length > 0 then median else null end),
   runs: map({input_tokens, cached_input_tokens, tool_use, ms, browser_ms, tools, ok})}' | tee -a "$here/results.jsonl"
