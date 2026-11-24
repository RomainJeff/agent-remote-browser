import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ActionButton } from '@/components/action-button';
import { Hint, Panel } from '@/components/page';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { detailsQuery, profilePath } from '@/lib/queries';
import { sessionQuery } from '@/lib/session';
import type { Computer } from '@/lib/types';
import { cn } from '@/lib/utils';

export function SessionTab({ c }: { c: Computer }) {
  return (
    <div className="flex max-w-[340px] min-w-0 flex-col gap-4 max-[1180px]:max-w-none">
      <Panel pad title="Agent lease"><Lease c={c} /></Panel>
      <Panel pad title="Agent activity"><Activity id={c.id} /></Panel>
      <Panel pad title="Connect an agent">
        <McpUrl />
        <p className="text-[13px] text-muted-foreground">OAuth is recommended: add the URL to your MCP client, sign in, then pick this profile. Otherwise, use an API key scoped to this profile.</p>
        <Link to="/access" className="font-semibold text-primary">Agent access →</Link>
      </Panel>
    </div>
  );
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function Lease({ c }: { c: Computer }) {
  const queryClient = useQueryClient(), now = useNow(1000), p = profilePath(c.id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['computers'] });
  if (!c.leasedUntil) return <p className="text-muted-foreground">Free. No agent is driving this profile. An agent takes a 10 min lease, extended on every action.</p>;
  const s = Math.max(0, Math.round((Date.parse(c.leasedUntil) - now) / 1000));
  return (
    <>
      <div>
        <span className="font-mono text-[28px] leading-9 font-bold">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>
        <Hint className="mt-1 block">Extended on every agent call. Ends at {new Date(c.leasedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.</Hint>
      </div>
      {c.role !== 'viewer' && (
        <div className="flex flex-wrap gap-2">
          <ActionButton variant="outline" size="sm" done="Lease extended to at least 30 min from now." action={async () => { await api(`${p}/extend`, 'POST', { minutes: 30 }); await refresh(); }}>Extend 30 min</ActionButton>
          <ActionButton variant="danger-outline" size="sm" done="Lease released. The agent has to take a new one." action={async () => { await api(`${p}/release`, 'POST'); await refresh(); }}>Force release</ActionButton>
        </div>
      )}
    </>
  );
}

function Activity({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const calls = data?.audit.slice(0, 6) ?? [];
  if (!calls.length) return <Hint>No calls yet.</Hint>;
  return (
    <ul className="flex flex-col gap-2.5 text-[13px]">
      {calls.map((l, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className={cn(!l.ok && 'text-destructive-ink')}>{l.ok ? '✓' : '✗'}</span>
          <span className="font-mono">{l.tool}</span>
          <time className="ml-auto text-xs whitespace-nowrap text-muted-foreground" dateTime={l.ts}>{ago(l.ts)}</time>
        </li>
      ))}
    </ul>
  );
}

const MCP_KEY = 'agentComputer.mcpUrl';
const stored = () => { try { return localStorage.getItem(MCP_KEY); } catch { return null; } };

/** The MCP endpoint (server side: PUBLIC_URL + /mcp), editable for this browser only. */
export function McpUrl() {
  const { data: session } = useQuery(sessionQuery);
  const [url, setUrl] = useState(() => stored());
  const value = url ?? session?.mcpUrl ?? '';
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-bold text-muted-foreground" htmlFor="mcpUrl">MCP server URL</label>
      <div className="flex gap-2">
        <Input id="mcpUrl" className="font-mono text-[13px]" spellCheck={false} autoComplete="off" value={value}
          onChange={(e) => setUrl(e.target.value)} onBlur={() => { try { localStorage.setItem(MCP_KEY, value.trim()); } catch {} }} />
        <CopyButton text={value.trim()} />
      </div>
      <Hint><code className="font-mono">PUBLIC_URL</code> + <code className="font-mono">/mcp</code>. Your edit stays in this browser.</Hint>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ActionButton variant="outline" size="lg" action={async () => {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>{copied ? 'Copied' : 'Copy'}</ActionButton>
  );
}
