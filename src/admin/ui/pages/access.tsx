import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { ActionButton } from '@/components/action-button';
import { FormError } from '@/components/auth-layout';
import { confirmSensitive } from '@/components/confirm';
import { CopyButton, McpUrl, mcpUrl } from '@/components/mcp-url';
import { PageHead, Sub } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, day, message, plural } from '@/lib/format';
import { clientsQuery, computersQuery } from '@/lib/queries';
import { sessionQuery } from '@/lib/session';
import type { Clients } from '@/lib/types';

/** Agents that can drive a profile: OAuth clients and API keys, in one table. */
export function AccessPage() {
  const { data } = useQuery({ ...clientsQuery, refetchInterval: 5000 });
  const [connecting, setConnecting] = useState(false);
  const rows = data ? toRows(data) : [];
  return (
    <>
      <PageHead title="Agent access" actions={<Button onClick={() => setConnecting(true)}>Connect an agent</Button>} />
      {!data ? null : !rows.length ? <p className="text-ink-2">No agent connected yet.</p> : (
        // Edge to edge in the main panel, right under the header bar.
        <div className="-mx-6 -mt-6 max-[700px]:-mx-4 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Agent</TableHead><TableHead>Can drive</TableHead><TableHead>Last used</TableHead><TableHead>Expires</TableHead>
              <TableHead><span className="sr-only">Action</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>{rows.map((r) => (
              <TableRow key={r.kind + r.id}>
                <TableCell><b className="font-semibold">{r.name}</b>{r.kind === 'clients' ? <Sub>Signed in with OAuth</Sub> : <Sub mono>{r.sub}</Sub>}</TableCell>
                <TableCell>{r.scope.includes('global') ? <><b className="font-semibold">All profiles</b><Sub>Current and future</Sub></>
                  : r.scope.length ? <span className="font-mono text-[13px]">{r.scope.map((s) => s.replace(/^profile:/, '')).join(', ')}</span>
                  : <span className="text-ink-3">Nothing yet<Sub>Removed after 24 h if never used</Sub></span>}</TableCell>
                <TableCell className="whitespace-nowrap">{r.used ? <span title={new Date(r.used).toLocaleString()}>{cap(ago(r.used))}</span> : <span className="text-ink-3">Never</span>}<Sub mono>{r.usedSub}</Sub></TableCell>
                <TableCell className="whitespace-nowrap">{r.expires}</TableCell>
                <TableCell className="w-px text-right"><Revoke kind={r.kind} id={r.id} name={r.name} /></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      )}
      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const inDays = (ts: string) => Math.max(0, Math.ceil((Date.parse(ts) - Date.now()) / 86400000));

function toRows(d: Clients) {
  return [
    ...d.oauth.map((c) => ({ kind: 'clients' as const, id: c.id, name: c.name || c.id, sub: c.id, scope: (c.scopes || '').split(',').filter(Boolean),
      created: c.createdAt, used: c.lastToken, usedSub: '', expires: <span className="text-ink-3">Renews on use</span> as ReactNode })),
    ...d.keys.map((k) => ({ kind: 'keys' as const, id: k.id, name: k.name, sub: `${k.start}…`, scope: k.scope ? [k.scope] : [], created: k.createdAt,
      used: k.lastRequest, usedSub: k.lastIp || '',
      expires: k.noExpiry ? <span className="flex items-center gap-1.5 font-medium"><CircleAlertIcon aria-hidden className="size-3.5" />No expiry, replace it</span>
        : <>{day(k.expiresAt!)}<Sub>In {plural(inDays(k.expiresAt!), 'day')}</Sub></> })),
  ].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

function Revoke({ kind, id, name }: { kind: 'clients' | 'keys'; id: string; name: string }) {
  const queryClient = useQueryClient();
  return (
    <ActionButton variant="outline" size="sm" done="Access revoked." action={async () => {
      if (!await confirmSensitive({ title: `Revoke ${name}?`, desc: `Its ${kind === 'keys' ? 'key stops' : 'tokens stop'} working now and its leases are released. The agent will need to reconnect.`, label: 'Revoke access', danger: true })) return false;
      await api(`/api/${kind}/${encodeURIComponent(id)}/revoke`, 'POST');
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    }}>Revoke…</ActionButton>
  );
}

/** OAuth first: the MCP URL is all a client needs. An API key for clients without OAuth, shown once. */
function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'oauth' | 'key'>('oauth');
  const [created, setCreated] = useState<Created | null>(null);
  const [saved, setSaved] = useState(false);
  // Dropped on close: the key leaves the page.
  const close = () => { setCreated(null); setSaved(false); setMode('oauth'); onClose(); };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && (!created || saved)) close(); }}>
      {open && (
        <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[520px]">
          {created ? <ShowKey k={created} saved={saved} setSaved={setSaved} onClose={close} />
            : mode === 'key' ? <KeyForm onCreated={setCreated} onCancel={close} />
            : (
              <div className="flex flex-col gap-4 p-[22px]">
                <div className="flex flex-col gap-1">
                  <DialogTitle className="text-base font-semibold">Connect an agent</DialogTitle>
                  <DialogDescription>Add this URL to the agent's MCP client. It registers itself, then you sign in with your code and pick the profiles it can drive.</DialogDescription>
                </div>
                <McpUrl />
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button variant="link" className="px-0 text-[13px] text-ink-2 underline underline-offset-[3px]" onClick={() => setMode('key')}>Use an API key instead</Button>
                  <Button size="lg" onClick={close}>Done</Button>
                </div>
              </div>
            )}
        </DialogContent>
      )}
    </Dialog>
  );
}

const isoDay = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const EXPIRY = { '30d': '30 days', '90d': '90 days', '1y': '1 year', date: 'Specific date' } as const;
const DAYS = { '30d': 30, '90d': 90, '1y': 365 };
type Created = { key: string; expiresAt: string; name: string; scope: string };

function KeyForm({ onCreated, onCancel }: { onCreated: (k: Created) => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const { data: computers = [] } = useQuery(computersQuery);
  const { data: session } = useQuery({ ...sessionQuery, staleTime: 0 });
  const [kind, setKind] = useState<'profile' | 'global'>(computers.length ? 'profile' : 'global');
  const [exp, setExp] = useState<keyof typeof EXPIRY>('90d');
  const [date, setDate] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const at = exp === 'date' ? (date ? new Date(date + 'T23:59:59') : null) : new Date(Date.now() + DAYS[exp] * 86400000);
  const stepUp = session?.stepUpRemainingS ?? 0;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const body = { name: String(data.get('name')).trim(), scope: kind === 'global' ? 'global' : String(data.get('profile')),
      ...(exp === 'date' ? { expiresAt: new Date(date + 'T23:59:59').toISOString() } : { expiresIn: exp }) };
    setBusy(true);
    try {
      const r = await api<{ key: string; expiresAt: string }>('/api/keys', 'POST', body);
      onCreated({ ...r, name: body.name, scope: body.scope });
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  const option = 'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 has-checked:border-ink';
  const hint = 'text-[13px] text-ink-2';

  return (
    <form className="flex flex-col gap-4 p-[22px]" onSubmit={submit}>
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-base font-semibold">Create an API key</DialogTitle>
        <DialogDescription>For a script or an MCP client without OAuth.</DialogDescription>
      </div>
      <Field>
        <FieldLabel htmlFor="kname">Name</FieldLabel>
        <Input id="kname" name="name" placeholder="ci-agent" pattern="[\w .\-]{1,60}" maxLength={60} required autoComplete="off" autoFocus />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-[13px] font-medium">Can drive</legend>
        <label className={option}>
          <input type="radio" name="kind" className="mt-0.5 accent-ink" checked={kind === 'profile'} disabled={!computers.length} onChange={() => setKind('profile')} />
          <span className="flex flex-auto flex-col"><b className="font-semibold">One profile</b><span className={hint}>The key only sees this browser.</span>
            <select name="profile" aria-label="Profile" disabled={kind !== 'profile'} className="mt-2 h-9 rounded-lg border border-input bg-card px-2.5 font-mono text-[13px]">
              {computers.map((c) => <option key={c.id} value={`profile:${c.id}`}>{c.id}</option>)}
            </select></span>
        </label>
        <label className={option}>
          <input type="radio" name="kind" className="mt-0.5 accent-ink" checked={kind === 'global'} onChange={() => setKind('global')} />
          <span className="flex flex-col"><b className="font-semibold">All profiles</b><span className={hint}>Manages and leases every profile, current and future.</span></span>
        </label>
      </fieldset>
      {kind === 'global' && <p className="flex items-start gap-1.5 text-[13px] leading-5 font-medium"><CircleAlertIcon aria-hidden className="mt-[3px] size-3.5 flex-none" />A leaked global key gives access to all your signed-in sessions. Prefer one key per profile.</p>}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-[13px] font-medium">Expires</legend>
        <select name="exp" aria-label="Expires" className="h-9 w-fit rounded-lg border border-input bg-card px-2.5" value={exp} onChange={(e) => setExp(e.target.value as keyof typeof EXPIRY)}>
          {(Object.keys(EXPIRY) as (keyof typeof EXPIRY)[]).map((v) => <option key={v} value={v}>{EXPIRY[v]}</option>)}
        </select>
        {exp === 'date' && <Input type="date" name="date" aria-label="Expiry date" min={isoDay(1)} max={isoDay(364)} required value={date} onChange={(e) => setDate(e.target.value)} />}
        <p className={hint}>{at ? `Expires ${day(at)}.` : 'Pick a date, 1 to 364 days from now.'}</p>
      </fieldset>
      {stepUp <= 0 && <p className={hint}>Creating the key asks for your code.</p>}
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="lg" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="lg" disabled={busy}>Create key</Button>
      </div>
    </form>
  );
}

function ShowKey({ k, saved, setSaved, onClose }: { k: Created; saved: boolean; setSaved: (v: boolean) => void; onClose: () => void }) {
  const { data: session } = useQuery(sessionQuery);
  return (
    <div className="flex flex-col gap-4 p-[22px]">
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-base font-semibold">Copy your key now</DialogTitle>
        <DialogDescription>{k.name}, {k.scope === 'global' ? 'all profiles' : k.scope.replace(/^profile:/, 'profile ')}, expires {day(k.expiresAt)}. It is never shown again: the server only keeps a hash. If you lose it, revoke it and create a new one.</DialogDescription>
      </div>
      <div className="flex gap-2">
        <Input className="font-mono" readOnly aria-label="API key" value={k.key} autoFocus onFocus={(e) => e.target.select()} />
        <CopyButton text={k.key} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">MCP config, with the key in the ARB_KEY variable</span>
        <pre className="overflow-auto rounded-xl bg-ink px-4 py-3 font-mono text-xs text-canvas">{JSON.stringify({ url: mcpUrl(session?.mcpUrl), headers: { Authorization: 'Bearer $ARB_KEY' } }, null, 2)}</pre>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-ink" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved the key somewhere safe</label>
      <div className="flex justify-end"><Button size="lg" disabled={!saved} onClick={onClose}>Close</Button></div>
    </div>
  );
}
