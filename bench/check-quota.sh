#!/usr/bin/env bash
# Lot 10 token bench: runs the n8n check_quota prompt N times through `claude -p` on one ARB profile, prints the median
# input tokens and tool calls, and appends one summary line to bench/results.jsonl.
#   ARB_MCP_URL=https://arb.example/mcp ARB_TOKEN=arb_k_... bench/check-quota.sh <label>   # label: baseline, 10a, ...
# ARB_TOKEN is a profile-scoped or global key (cli.ts key create <profile>|--global); it only goes into a 0600 temp file, never argv or output.
# COMMIT overrides the recorded commit (the stack's, when the script runs from another branch).
# Per run: the tools called, and browser_ms = the "ms" of the run_steps / run_playbook / pb_ replies: the gateway's step loop,
# runner round trips included. Total ms minus browser_ms is client startup + MCP init + other calls + model, not model alone.
# A run is ok only if the client finished, every browser reply says ok:true and the answer holds two numbers; medians use ok runs only.
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
# The key reaches jq through its environment, not argv (visible in ps).
ARB_TOKEN="$ARB_TOKEN" jq -n --arg url "$ARB_MCP_URL" \
  '{mcpServers: {arb: {type: "http", url: $url, headers: {Authorization: ("Bearer " + env.ARB_TOKEN)}}}}' > "$tmp/mcp.json"
unset ARB_TOKEN

# The answer must hold two whole numbers ("1,234 / 2,500", "1234 of 2500").
TWO='[0-9][0-9,.]*[^0-9,.]+[0-9][0-9,.]*'
runs=()
for i in $(seq "$N"); do
  # Empty cwd and no settings: no CLAUDE.md, hooks or other MCP servers in the measure. Only the arb tools are allowed.
  rc=0
  (cd "$tmp" && claude -p "$PROMPT" --mcp-config "$tmp/mcp.json" --strict-mcp-config --setting-sources project \
    --tools "" --allowedTools mcp__arb --no-session-persistence --output-format stream-json --verbose) > "$tmp/run$i.jsonl" || rc=$?
  # Browser calls (run_steps, run_playbook, pb_*) are matched to their reply by tool_use_id: each needs a JSON reply with ok:true.
  r=$(jq -s --argjson rc "$rc" '[.[] | select(.type == "assistant") | .message.content[] | select(.type == "tool_use")
      | {id, name: (.name | sub("^mcp__arb__"; ""))}] as $calls
    | ([.[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result")
      | {key: .tool_use_id, value: ((.content | if type == "array" then map(.text? // "") | join("") else . end) | split("\n")[0] | fromjson? // {})}]
      | from_entries) as $reply
    | [$calls[] | select(.name | test("^(run_steps|run_playbook|pb_.+)$")) | $reply[.id] // {}] as $b
    | last(.[] | select(.type == "result")) as $res | ($res.result // "") as $a | {
    input_tokens: ($res.usage | .input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens),
    tool_use: ($calls | length),
    tools: ($calls | map(.name)),
    browser_ms: ($b | map(.ms // empty) | add),
    ms: $res.duration_ms,
    exit: $rc,
    ok: ($rc == 0 and $res != null and ($res.is_error | not) and ($b | length > 0 and all(.ok == true)) and ($a | test($two))),
    answer: ($a | .[0:200])}' --arg two "$TWO" "$tmp/run$i.jsonl" 2> /dev/null) || r=$(jq -n --argjson rc "$rc" '{exit: $rc, ok: false, answer: "unparseable output"}')
  echo "run $i: $(jq -c . <<<"$r")"
  runs+=("$r")
done

printf '%s\n' "${runs[@]}" | jq -s -c --arg label "$label" --arg at "$(date -u +%FT%TZ)" --arg commit "${COMMIT:-$(git -C "$here" rev-parse --short HEAD)}" '
  def median: sort | if length == 0 then null elif length % 2 == 1 then .[length / 2 | floor] else (.[length / 2 - 1] + .[length / 2]) / 2 end;
  {label: $label, at: $at, commit: $commit, n: length, ok: (map(select(.ok)) | length),
   failed: map(select(.ok | not) | .answer),
   median_input_tokens: (map(select(.ok) | .input_tokens) | median), median_tool_use: (map(select(.ok) | .tool_use) | median),
   median_ms: (map(select(.ok) | .ms) | median), median_browser_ms: (map(select(.ok) | .browser_ms // empty) | median),
   runs: map({input_tokens, tool_use, ms, browser_ms, tools, exit, ok})}' | tee -a "$here/results.jsonl"
