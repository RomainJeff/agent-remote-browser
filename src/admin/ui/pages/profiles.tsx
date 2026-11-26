import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { PageHead, Sub } from '@/components/page';
import { ControlFrame, ControlTab, DriverToken, driverOf, type Driver } from '@/components/state';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, domains, message, plural } from '@/lib/format';
import { openView, takeControl, takeOver } from '@/lib/live';
import { computersQuery } from '@/lib/queries';
import type { Computer } from '@/lib/types';
import { cn } from '@/lib/utils';

/** The list is grouped by who drives, people first: a request waiting for someone is the reason to open this page. */
const GROUPS: { title: string; has: Driver[] }[] = [
  { title: 'Needs you', has: ['waiting', 'you'] },
  { title: 'Agent driving', has: ['agent'] },
  { title: 'Running', has: ['nobody'] },
  { title: 'Stopped', has: ['stopped'] },
];

export function ProfilesPage() {
  const { data: computers = [], isPending } = useQuery(computersQuery);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = search.trim().toLowerCase();
  const rows = computers.filter((c) => !q || c.id.includes(q) || c.allow.some((d) => d.includes(q)));
  const groups = GROUPS.map((g) => ({ ...g, rows: rows.filter((c) => g.has.includes(driverOf(c))) })).filter((g) => g.rows.length);

  return (
    <>
      <PageHead title="Profiles" actions={computers.length > 0 && <>
        <Input type="search" className="h-8 w-[220px] bg-surface-2" placeholder="Search" aria-label="Search profiles" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button onClick={() => setCreating(true)}>New profile</Button>
      </>} />
      {isPending ? null : !computers.length ? <FirstProfile onCreate={() => setCreating(true)} />
        : !rows.length ? <p className="text-ink-3">No profile matches “{search.trim()}”.</p> : (
          // Edge to edge in the main panel, right under the header bar.
          <div className="-mx-6 -mt-6 max-[700px]:-mx-4 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Profile</TableHead><TableHead>Control</TableHead><TableHead>Last activity</TableHead><TableHead>Access</TableHead>
                <TableHead><span className="sr-only">Action</span></TableHead>
              </TableRow></TableHeader>
              {groups.map((g) => (
                <TableBody key={g.title} className="[&_tr:last-child]:border-b">
                  <TableRow className="bg-surface-2 hover:bg-surface-2">
                    <th colSpan={5} scope="colgroup" className="h-9 pl-5 text-left text-[13px] font-semibold">{g.title}<span className="ml-1.5 font-medium text-ink-3">{g.rows.length}</span></th>
                  </TableRow>
                  {g.rows.map((c) => <ProfileRow key={c.id} c={c} />)}
                </TableBody>
              ))}
            </Table>
          </div>
        )}
      <NewProfileDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function ProfileRow({ c }: { c: Computer }) {
  const queryClient = useQueryClient(), navigate = useNavigate();
  const d = driverOf(c), h = c.handoff, viewer = c.role === 'viewer';
  const idle = c.state === 'running' && c.idleStopInS != null ? `stops in ${Math.ceil(c.idleStopInS / 60)} min if idle` : '';
  const open = (then: () => unknown) => async () => { await navigate({ to: '/profiles/$id', params: { id: c.id } }); await then(); };
  return (
    <TableRow className={cn(d === 'waiting' && 'bg-needs-you-soft/40 hover:bg-needs-you-soft/60')}>
      <TableCell>
        <Link to="/profiles/$id" params={{ id: c.id }} className="font-semibold hover:underline">{c.id}</Link>
        <Sub mono>{c.allow.join(', ')}</Sub>
      </TableCell>
      <TableCell className="whitespace-nowrap"><DriverToken c={c} />{c.viewers > 0 && <Sub>{plural(c.viewers, 'viewer')}</Sub>}</TableCell>
      <TableCell className="max-w-[360px]">
        {h ? <>
          {/* The agent's words: quoted, never phrased as an instruction from this page. */}
          <q className="line-clamp-2 [overflow-wrap:anywhere]">{h.reason}</q><Sub>Asked {ago(h.created)}</Sub>
        </> : c.lastCall ? <>
          <span className="font-mono text-[13px]">{c.lastCall.tool}</span>{!c.lastCall.ok && ', failed'}
          <Sub>{[ago(c.lastCall.ts), idle].filter(Boolean).join(', ')}</Sub>
        </> : <><span className="text-ink-3">No activity yet</span>{idle && <Sub>{idle}</Sub>}</>}
      </TableCell>
      <TableCell className="whitespace-nowrap"><span className="capitalize">{c.role}</span><Sub>{c.members === 1 ? 'Private' : `Shared, ${plural(c.members, 'member')}`}</Sub></TableCell>
      <TableCell className="w-px text-right whitespace-nowrap">
        {d === 'waiting'
          ? <ActionButton size="sm" action={open(() => takeOver(queryClient, c.id))}>Take over</ActionButton>
          : c.state === 'running'
            ? <ActionButton variant="outline" size="sm" action={open(() => openView(c.id, false))}>Watch</ActionButton>
            : <ActionButton variant="outline" size="sm" action={open(() => takeControl(queryClient, c.id, !viewer))}>{viewer ? 'Start and watch' : 'Start'}</ActionButton>}
      </TableCell>
    </TableRow>
  );
}

/** No profile yet: an empty frame, nobody driving it. */
function FirstProfile({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-auto items-center justify-center py-16">
      <div className="flex w-full max-w-[520px] flex-col items-start">
        <ControlTab driver="stopped">Nobody</ControlTab>
        <ControlFrame driver="stopped" className="gap-5 self-stretch px-8 py-9 max-[700px]:px-5">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-lg font-semibold">Create your first profile</h2>
            <p className="text-ink-2">A profile is a browser your agents can drive, with its own cookies, saved logins and allowed sites.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={onCreate}>New profile</Button>
            <Link to="/access" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}>Connect an agent</Link>
          </div>
        </ControlFrame>
      </div>
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
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[460px]">
        <form className="flex flex-col gap-4 p-[22px]" onSubmit={submit}>
          <DialogTitle className="text-base font-semibold">New profile</DialogTitle>
          <Field>
            <FieldLabel htmlFor="pid">Name</FieldLabel>
            <Input id="pid" name="id" className="font-mono" placeholder="notion-research" pattern="[a-z0-9][a-z0-9\-]{0,39}" required autoComplete="off" spellCheck={false} autoFocus
              title="Lowercase letters, digits and hyphens, 40 max. Starts with a letter or digit." />
            <FieldDescription>Lowercase letters, digits and hyphens. Agents use it to pick this browser.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="pallow">Allowed domains</FieldLabel>
            <textarea id="pallow" name="allow" rows={3} required autoComplete="off" spellCheck={false} placeholder={'notion.so\nexample.com'}
              className="w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
            <FieldDescription>One per line. Subdomains are included. You can change them later.</FieldDescription>
          </Field>
          {error && <p role="alert" className="text-[13px] font-medium">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="lg" disabled={busy}>Create profile</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
