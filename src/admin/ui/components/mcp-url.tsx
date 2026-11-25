import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActionButton } from '@/components/action-button';
import { Hint } from '@/components/page';
import { Input } from '@/components/ui/input';
import { sessionQuery } from '@/lib/session';

const MCP_KEY = 'agentComputer.mcpUrl';
const stored = () => { try { return localStorage.getItem(MCP_KEY); } catch { return null; } };
/** The URL to give MCP clients: this browser's edit, else the server's (PUBLIC_URL + /mcp). */
export const mcpUrl = (server = '') => stored() || server;

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
