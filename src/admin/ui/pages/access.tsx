import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { CopyButton, McpUrl, mcpUrl } from '@/components/mcp-url';
import { Alert, Empty, Hint, PageHead, Panel, Sub } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, day, message } from '@/lib/format';
import { clientsQuery, computersQuery } from '@/lib/queries';
import { sessionQuery } from '@/lib/session';
import type { Clients } from '@/lib/types';

const Scope = ({ s }: { s: string }) => s === 'global' ? <Badge variant="danger">Global</Badge> : <Badge variant="up" className="font-mono">{s.replace(/^profile:/, '')}</Badge>;

/** OAuth clients and API keys: everything that can drive a profile. */
export function AccessPage() {
  const { data } = useQuery({ ...clientsQuery, refetchInterval: 5000 });
  const [creating, setCreating] = useState(false);
  const rows = data ? toRows(data) : [];
  return (
    <>
      <PageHead title="Agent access" sub="Everything that can drive a profile, in one place: OAuth clients and API keys."
        actions={<Button size="lg" onClick={() => setCreating(true)}>+ Create API key</Button>} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] items-start gap-6">
        <Panel pad title={<span className="flex items-center gap-2">OAuth <Badge variant="up">recommended</Badge></span>}>
          <p className="text-muted-foreground">Add the MCP URL to the client. It registers itself. You sign in with your 2FA code, then pick the profiles on the consent page.</p>
          <McpUrl />
        </Panel>
        <Panel pad title="API key">
          <p className="text-muted-foreground [&_code]:font-mono">For scripts and clients without OAuth. Scope it to one profile when you can. Expiry is required and the key is shown only once. Send it as <code>Authorization: Bearer arb_k_…</code> or <code>x-api-key</code>.</p>
        </Panel>
      </div>
      <Panel title={data ? `Active access · ${rows.length}` : 'Active access'}>
        {!data ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No access yet. Add the MCP URL to a client (OAuth) or create an API key.</Empty> : (
          <Table>
            <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Type</TableHead><TableHead>Scope</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead><TableHead><span className="sr-only">Revoke</span></TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((r) => (
              <TableRow key={r.kind + r.id}>
                <TableCell><b>{r.name}</b><Sub mono>{r.sub}</Sub></TableCell>
                <TableCell>{r.kind === 'clients' ? <Badge variant="agent">OAuth</Badge> : <Badge variant="muted">API key</Badge>}</TableCell>
                <TableCell>{r.scope.length ? <span className="flex flex-wrap gap-1">{r.scope.map((s) => <Scope key={s} s={s} />)}</span> : <Hint>never used · deleted after 24 h</Hint>}</TableCell>
                <TableCell className="whitespace-nowrap">{ago(r.created)}<Sub>{r.extra}</Sub></TableCell>
                <TableCell className="whitespace-nowrap">{r.used ? ago(r.used) : 'never'}<Sub mono>{r.usedSub}</Sub></TableCell>
                <TableCell className="w-px text-right"><Revoke kind={r.kind} id={r.id} name={r.name} /></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
        <div className="border-t border-muted px-5 py-3"><Hint>Revoking cuts the tokens right away and releases the agent's leases.</Hint></div>
      </Panel>
      <KeyDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function toRows(d: Clients) {
  return [
    ...d.oauth.map((c) => ({ kind: 'clients' as const, id: c.id, name: c.name || c.id, sub: c.id, scope: (c.scopes || '').split(',').filter(Boolean),
      created: c.createdAt, extra: null as React.ReactNode, used: c.lastToken, usedSub: '' })),
    ...d.keys.map((k) => ({ kind: 'keys' as const, id: k.id, name: k.name, sub: `${k.start}…`, scope: k.scope ? [k.scope] : [], created: k.createdAt,
      extra: k.noExpiry ? <Badge dot variant="warn">no expiry: replace it</Badge> : `expires ${day(k.expiresAt!)}`, used: k.lastRequest, usedSub: k.lastIp || '' })),
  ].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

function Revoke({ kind, id, name }: { kind: 'clients' | 'keys'; id: string; name: string }) {
  const queryClient = useQueryClient();
  return (
    <ActionButton variant="danger-outline" size="sm" done="Access revoked." action={async () => {
      if (!await confirmSensitive({ title: `Revoke "${name}"?`, desc: 'Its tokens are cut right away and its leases released. The agent will need to reconnect.', label: 'Revoke', danger: true })) return false;
      await api(`/api/${kind}/${encodeURIComponent(id)}/revoke`, 'POST');
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    }}>Revoke</ActionButton>
  );
}

const isoDay = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const EXPIRY = { '30d': '30 days', '90d': '90 days', '1y': '1 year', date: 'Specific date' } as const;
const DAYS = { '30d': 30, '90d': 90, '1y': 365 };
type Created = { key: string; expiresAt: string; name: string; scope: string };

/** API key: created in a dialog, shown once, closable only after the "saved it" box is ticked. */
function KeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [created, setCreated] = useState<Created | null>(null);
  const [saved, setSaved] = useState(false);
  // Dropped on close: the key leaves the page.
  const close = () => { setCreated(null); setSaved(false); onClose(); };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && (!created || saved)) close(); }}>
      {open && (
        <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[560px]">
          {created ? <ShowKey k={created} saved={saved} setSaved={setSaved} onClose={close} /> : <KeyForm onCreated={setCreated} onCancel={close} />}
        </DialogContent>
      )}
    </Dialog>
  );
}

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
  const option = 'flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-secondary/40';

  return (
    <form className="flex flex-col gap-4 p-6" onSubmit={submit}>
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-xl font-extrabold">Create an API key</DialogTitle>
        <DialogDescription>For a script or an MCP client without OAuth.</DialogDescription>
      </div>
      <Field>
        <FieldLabel htmlFor="kname">Name</FieldLabel>
        <Input id="kname" name="name" placeholder="ci-agent" pattern="[\w .\-]{1,60}" maxLength={60} required autoComplete="off" autoFocus />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-bold text-muted-foreground">Scope</legend>
        <label className={option}>
          <input type="radio" name="kind" className="mt-1 accent-primary" checked={kind === 'profile'} disabled={!computers.length} onChange={() => setKind('profile')} />
          <span className="flex flex-auto flex-col"><b>One profile</b><Hint>The key only sees this browser.</Hint>
            <select name="profile" aria-label="Profile" disabled={kind !== 'profile'} className="mt-2 h-9 rounded-lg border border-input bg-card px-2.5">
              {computers.map((c) => <option key={c.id} value={`profile:${c.id}`}>{c.id}</option>)}
            </select></span>
        </label>
        <label className={option}>
          <input type="radio" name="kind" className="mt-1 accent-primary" checked={kind === 'global'} onChange={() => setKind('global')} />
          <span className="flex flex-col"><b>All profiles</b><Hint>Manages and leases every profile, current and future.</Hint></span>
        </label>
      </fieldset>
      {kind === 'global' && <Alert kind="danger">A leaked global key gives access to all your signed-in sessions. Prefer one key per profile.</Alert>}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-bold text-muted-foreground">Expiry</legend>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(EXPIRY) as (keyof typeof EXPIRY)[]).map((v) => (
            <label key={v} className="relative">
              <input type="radio" name="exp" value={v} checked={exp === v} onChange={() => setExp(v)} className="peer absolute opacity-0" />
              <span className="inline-flex h-9 cursor-pointer items-center rounded-full border px-3.5 font-semibold peer-checked:border-primary peer-checked:bg-secondary peer-checked:text-primary peer-focus-visible:outline-2 peer-focus-visible:outline-primary">{EXPIRY[v]}</span>
            </label>
          ))}
        </div>
        {exp === 'date' && <Input type="date" name="date" aria-label="Expiry date" min={isoDay(1)} max={isoDay(364)} required value={date} onChange={(e) => setDate(e.target.value)} />}
        <Hint>{at ? `Expires ${day(at)}.` : 'Pick a date (1 to 364 days).'} There is no "never" option.</Hint>
      </fieldset>
      <Hint>{stepUp > 0 ? `2FA code verified: no code needed for the next ${Math.ceil(stepUp / 60)} min.` : 'You will be asked for your 2FA code when you create the key.'}</Hint>
      <p aria-live="polite" className="min-h-5 text-[13px] font-semibold text-destructive-ink">{error}</p>
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
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <DialogTitle className="text-xl font-extrabold">Key created: copy it now</DialogTitle>
        <DialogDescription>{k.name} · {k.scope === 'global' ? 'all profiles' : k.scope.replace(/^profile:/, 'profile ')} · expires {day(k.expiresAt)}</DialogDescription>
      </div>
      <Alert kind="warn">It will never be shown again: the server only keeps a hash. If you lose it, revoke it and create a new one.</Alert>
      <div className="flex gap-2">
        <Input className="font-mono" readOnly aria-label="API key" value={k.key} autoFocus onFocus={(e) => e.target.select()} />
        <CopyButton text={k.key} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-bold text-muted-foreground">MCP config (the key goes in the ARB_KEY variable)</span>
        <pre className="overflow-auto rounded-lg bg-[#1F2226] p-3 font-mono text-xs text-[#E9EBEC]">{JSON.stringify({ url: mcpUrl(session?.mcpUrl), headers: { Authorization: 'Bearer $ARB_KEY' } }, null, 2)}</pre>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved the key somewhere safe</label>
      <div className="flex justify-end"><Button size="lg" disabled={!saved} onClick={onClose}>Close</Button></div>
    </div>
  );
}
