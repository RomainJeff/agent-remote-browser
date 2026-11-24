import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { Empty, Hint, PageHead, Panel, Sub } from '@/components/page';
import { LeasePill, StatePill, stateNote } from '@/components/state';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, domains, message } from '@/lib/format';
import { clientsQuery, computersQuery, profilePath } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function ProfilesPage() {
  const { data: computers = [] } = useQuery(computersQuery);
  const { data: clients } = useQuery(clientsQuery);
  const [filter, setFilter] = useState<'all' | 'up'>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient(), navigate = useNavigate();
  const up = computers.filter((c) => c.state === 'running');
  const q = search.trim().toLowerCase();
  const rows = computers.filter((c) => (filter === 'all' || c.state === 'running') && (!q || c.id.includes(q) || c.allow.some((d) => d.includes(q))));

  return (
    <>
      <PageHead title="Profiles" sub="Each profile is an isolated browser with its own cookies, saved logins and allowed domains."
        actions={<>
          <Link to="/access" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}>Connect an agent</Link>
          <Button size="lg" onClick={() => setCreating(true)}>+ New profile</Button>
        </>} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <Stat label="Running browsers">{up.length} <small className="text-sm font-semibold text-muted-foreground">of {computers.length}</small></Stat>
        <Stat label="Active agent leases">{computers.filter((c) => c.leasedUntil).length}</Stat>
        <Stat label="Agent access">{clients ? clients.keys.length + clients.oauth.length : '…'}</Stat>
      </div>
      <Panel title="All profiles" aside={<>
        <div className="flex gap-1.5" role="group" aria-label="Filter">
          {(['all', 'up'] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className="h-8 cursor-pointer rounded-full border bg-card px-3 text-xs font-bold text-muted-foreground aria-pressed:border-primary aria-pressed:bg-secondary aria-pressed:text-primary">
              {f === 'all' ? `All · ${computers.length}` : `Running · ${up.length}`}
            </button>
          ))}
        </div>
        <Input type="search" className="w-[220px]" placeholder="Search profiles" aria-label="Search profiles" value={search} onChange={(e) => setSearch(e.target.value)} />
      </>}>
        {!computers.length ? <Empty>No profiles yet. Create one, then take over to sign in to your sites.</Empty>
          : !rows.length ? <Empty>No matching profiles.</Empty> : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Profile</TableHead><TableHead>Access</TableHead><TableHead>State</TableHead><TableHead>Agent</TableHead><TableHead>Last activity</TableHead>
                <TableHead><span className="sr-only">Action</span></TableHead>
              </TableRow></TableHeader>
              <TableBody>{rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell><Link to="/profiles/$id" params={{ id: c.id }} className="font-mono font-semibold text-primary">{c.id}</Link><Sub>{c.allow.join(', ')}</Sub></TableCell>
                  <TableCell>{c.role}<Sub>{c.members === 1 ? 'Private' : 'Shared'}</Sub></TableCell>
                  <TableCell><StatePill c={c} /><Sub>{stateNote(c)}</Sub></TableCell>
                  <TableCell><LeasePill c={c} /></TableCell>
                  <TableCell>{c.lastCall ? <>{ago(c.lastCall.ts)}<Sub mono>{c.lastCall.tool}{c.lastCall.ok ? '' : ' · failed'}</Sub></> : <Hint>No calls</Hint>}</TableCell>
                  <TableCell className="w-px text-right whitespace-nowrap">
                    <ActionButton variant="outline" size="sm" action={async () => {
                      if (c.state !== 'running') { await api(`${profilePath(c.id)}/start`, 'POST'); await queryClient.invalidateQueries({ queryKey: ['computers'] }); }
                      await navigate({ to: '/profiles/$id', params: { id: c.id } });
                    }}>{c.state === 'running' ? 'Watch' : 'Start'}</ActionButton>
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        <div className="border-t border-muted px-5 py-3"><Hint>An idle browser stops on its own. Its cookies and saved logins are kept.</Hint></div>
      </Panel>
      <NewProfileDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card px-5 py-4">
      <span className="text-xs font-bold text-muted-foreground">{label}</span>
      <b className="text-[28px] leading-9 font-extrabold">{children}</b>
    </div>
  );
}

function NewProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const queryClient = useQueryClient(), navigate = useNavigate();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/api/profiles', 'POST', { id: String(data.get('id')).trim(), allow: domains(String(data.get('allow'))) });
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ['computers'] });
      await navigate({ to: '/profiles/$id', params: { id: r.id } });
      toast(`Profile ${r.id} created. Take over to sign in to your sites.`);
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); setError(''); }}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[520px]">
        <form className="flex flex-col gap-4 p-6" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-extrabold">New profile</DialogTitle>
            <DialogDescription>An isolated browser. The agent can only open the allowed domains.</DialogDescription>
          </div>
          <Field>
            <FieldLabel htmlFor="pid">Profile name</FieldLabel>
            <Input id="pid" name="id" className="font-mono" placeholder="notion-research" pattern="[a-z0-9][a-z0-9\-]{0,39}" required autoComplete="off" spellCheck={false} autoFocus
              title="Lowercase letters, digits and hyphens, 40 max. Starts with a letter or digit." />
          </Field>
          <Field>
            <FieldLabel htmlFor="pallow">Allowed domains</FieldLabel>
            <Input id="pallow" name="allow" className="font-mono" placeholder="notion.so, example.com" required autoComplete="off" spellCheck={false} />
            <FieldDescription>Comma-separated. Subdomains are included.</FieldDescription>
          </Field>
          <Hint>Next: take over to sign in to your sites, add saved logins if needed, then connect an agent.</Hint>
          <p aria-live="polite" className={cn('min-h-5 text-[13px] font-semibold text-destructive-ink')}>{error}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="lg" disabled={busy}>Create profile</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
