#!/usr/bin/env bash
# check-quota.sh, through `codex exec` instead of `claude -p`: same env, same summary line in bench/results.jsonl.
#   ARB_MCP_URL=http://127.0.0.1:18787/mcp ARB_TOKEN=arb_k_... PROMPT='...' bench/codex-quota.sh <label>
# The ARB server comes from -c overrides; the key stays in the environment (bearer_token_env_var), never in
# ~/.codex/config.toml, argv or output. --ignore-user-config: no other MCP server, plugin or instruction in the measure
# (auth still comes from ~/.codex). Input tokens = Codex's input_tokens (cached ones included), Codex's own tools and
# system prompt included: not comparable 1:1 with claude -p. ms = wall time of the codex process. tool_use counts MCP calls
# and Codex's built-in ones (shell, patch, search); browser_ms and ok follow check-quota.sh. A failed codex run is
# recorded with its exit code (stderr dropped: it is not ours to log) and the batch goes on.
set -euo pipefail
label=${1:?usage: $0 <label>}
: "${ARB_MCP_URL:?set ARB_MCP_URL}" "${ARB_TOKEN:?set ARB_TOKEN}" "${PROMPT:?set PROMPT}"
export ARB_TOKEN
N=${N:-3}
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
now() { python3 -c 'import time; print(int(time.time() * 1000))'; }

TWO='[0-9][0-9,.]*[^0-9,.]+[0-9][0-9,.]*'  # two whole numbers, as in check-quota.sh
runs=()
for i in $(seq "$N"); do
  t0=$(now)
  rc=0
  (cd "$tmp" && codex exec --ignore-user-config --skip-git-repo-check --ephemeral --json -s read-only \
    -c "mcp_servers.arb.url=\"$ARB_MCP_URL\"" -c 'mcp_servers.arb.bearer_token_env_var="ARB_TOKEN"' \
    -c 'mcp_servers.arb.default_tools_approval_mode="approve"' "$PROMPT" < /dev/null) > "$tmp/run$i.jsonl" 2> /dev/null || rc=$?
  ms=$(( $(now) - t0 ))
  r=$(jq -s --argjson ms "$ms" --argjson rc "$rc" --arg two "$TWO" '[.[] | select(.type == "item.completed") | .item
      | select(.type | IN("agent_message", "reasoning", "todo_list", "error") | not)] as $calls
    | [$calls[] | select(.type == "mcp_tool_call" and (.tool | test("^(run_steps|run_playbook|pb_.+)$")))
      | .result.content[0].text? // "" | split("\n")[0] | fromjson? // {}] as $b
    | last(.[] | select(.type == "turn.completed")) as $turn
    | (last(.[] | select(.type == "item.completed" and .item.type == "agent_message")).item.text // "") as $a | {
    input_tokens: $turn.usage.input_tokens,
    cached_input_tokens: $turn.usage.cached_input_tokens,
    tool_use: ($calls | length),
    tools: ($calls | map(.tool // .type)),
    browser_ms: ($b | map(.ms // empty) | add),
    ms: $ms,
    exit: $rc,
    ok: ($rc == 0 and $turn != null and ($b | length > 0 and all(.ok == true)) and ($a | test($two))),
    answer: ($a | .[0:200])}' "$tmp/run$i.jsonl" 2> /dev/null) || r=$(jq -n --argjson rc "$rc" '{exit: $rc, ok: false, answer: "unparseable output"}')
  echo "run $i: $(jq -c . <<<"$r")"
  runs+=("$r")
done

printf '%s\n' "${runs[@]}" | jq -s -c --arg label "$label" --arg at "$(date -u +%FT%TZ)" --arg commit "${COMMIT:-$(git -C "$here" rev-parse --short HEAD)}" '
  def median: sort | if length == 0 then null elif length % 2 == 1 then .[length / 2 | floor] else (.[length / 2 - 1] + .[length / 2]) / 2 end;
  {label: $label, client: "codex exec", at: $at, commit: $commit, n: length, ok: (map(select(.ok)) | length),
   failed: map(select(.ok | not) | .answer),
   median_input_tokens: (map(select(.ok) | .input_tokens) | median), median_tool_use: (map(select(.ok) | .tool_use) | median),
   median_ms: (map(select(.ok) | .ms) | median), median_browser_ms: (map(select(.ok) | .browser_ms // empty) | median),
   runs: map({input_tokens, cached_input_tokens, tool_use, ms, browser_ms, tools, exit, ok})}' | tee -a "$here/results.jsonl"
