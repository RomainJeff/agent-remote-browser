// Prometheus text format (0.0.4), no dependency. Counters live in this process (reset on restart, as Prometheus
// expects); gauges are read at scrape time by the caller. Label values come from fixed sets chosen by the gateway
// (listener, tool name, outcome, failure kind): never from a request.
const HELP = {
  arb_http_requests_total: 'HTTP requests received, by listener.',
  arb_tool_calls_total: 'MCP tool calls, by tool and outcome.',
  arb_auth_failures_total: 'Refused credentials: unknown MCP token, wrong password, wrong TOTP code, rate limited.',
  arb_egress_denied_total: 'Browser connections refused by the egress proxy (domain not allowed, private address, bad port).',
} as const;
type Counter = keyof typeof HELP;

const counters = new Map<string, number>([['arb_egress_denied_total', 0]]); // unlabeled: shown from the start
const key = (name: Counter, labels: Record<string, string>) => {
  const l = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  return l ? `${name}{${l}}` : name;
};

export function count(name: Counter, labels: Record<string, string> = {}) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + 1);
}

/** The exposition text: every counter, then the given gauges. */
export function render(gauges: Record<string, { help: string; value: number }>) {
  const lines: string[] = [];
  for (const [name, help] of Object.entries(HELP)) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    const own = [...counters].filter(([k]) => k === name || k.startsWith(name + '{'));
    for (const [k, v] of own) lines.push(`${k} ${v}`);
  }
  for (const [name, g] of Object.entries(gauges)) lines.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`, `${name} ${g.value}`);
  return lines.join('\n') + '\n';
}
