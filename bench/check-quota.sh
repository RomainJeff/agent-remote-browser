#!/usr/bin/env bash
# Lot 10 token bench: runs the n8n check_quota prompt N times through `claude -p` on one ARB profile, prints the median
# input tokens and tool calls, and appends one summary line to bench/results.jsonl.
#   ARB_MCP_URL=https://arb.example/mcp ARB_TOKEN=arb_k_... bench/check-quota.sh <label>   # label: baseline, 10a, ...
# ARB_TOKEN is a profile-scoped key (profile:<n8n>); it only goes into a 0600 temp file, never argv or output.
# Input tokens = input + cache creation + cache read, summed over the run (what the model actually read).
# ponytail: stream-json, not --output-format json: only the stream shows each tool_use.
set -euo pipefail
label=${1:?usage: $0 <label>}
: "${ARB_MCP_URL:?set ARB_MCP_URL}" "${ARB_TOKEN:?set ARB_TOKEN}"
N=${N:-3}
PROMPT=${PROMPT:-'With the arb browser tools, open https://app.n8n.cloud/manage, log in with the login tool if needed, open the evaneos workspace and tell me how many executions are used this month out of the quota. Answer with the two numbers only.'}
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
umask 077
jq -n --arg url "$ARB_MCP_URL" --arg tok "$ARB_TOKEN" \
  '{mcpServers: {arb: {type: "http", url: $url, headers: {Authorization: ("Bearer " + $tok)}}}}' > "$tmp/mcp.json"

runs=()
for i in $(seq "$N"); do
  # Empty cwd and no settings: no CLAUDE.md, hooks or other MCP servers in the measure. Only the arb tools are allowed.
  (cd "$tmp" && claude -p "$PROMPT" --mcp-config "$tmp/mcp.json" --strict-mcp-config --setting-sources project \
    --tools "" --allowedTools mcp__arb --no-session-persistence --output-format stream-json --verbose) > "$tmp/run$i.jsonl"
  r=$(jq -s '{
    input_tokens: (last(.[] | select(.type == "result")).usage | .input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens),
    tool_use: [.[] | select(.type == "assistant") | .message.content[] | select(.type == "tool_use")] | length,
    ms: last(.[] | select(.type == "result")).duration_ms,
    ok: (last(.[] | select(.type == "result")).is_error | not),
    answer: (last(.[] | select(.type == "result")).result // "" | .[0:200])}' "$tmp/run$i.jsonl")
  echo "run $i: $(jq -c . <<<"$r")"
  runs+=("$r")
done

printf '%s\n' "${runs[@]}" | jq -s -c --arg label "$label" --arg at "$(date -u +%FT%TZ)" --arg commit "$(git -C "$here" rev-parse --short HEAD)" '
  def median: sort | .[length / 2 | floor];
  {label: $label, at: $at, commit: $commit, n: length, ok: (map(select(.ok)) | length),
   median_input_tokens: (map(.input_tokens) | median), median_tool_use: (map(.tool_use) | median), median_ms: (map(.ms) | median),
   runs: map({input_tokens, tool_use, ms, ok})}' | tee -a "$here/results.jsonl"
