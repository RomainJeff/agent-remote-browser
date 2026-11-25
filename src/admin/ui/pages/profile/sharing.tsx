import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { Hint, Panel, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { message } from '@/lib/format';
import { candidatesQuery, membersQuery, profilePath } from '@/lib/queries';
import { sessionQuery } from '@/lib/session';
import type { Computer, Role } from '@/lib/types';

const ROLES: Role[] = ['viewer', 'editor', 'admin'];
const selectClass = 'h-8 rounded-lg border border-input bg-card px-2 text-sm';
const label = (r: Role) => r[0].toUpperCase() + r.slice(1);

export function SharingTab({ c }: { c: Computer }) {
  const admin = c.role === 'admin';
  const { data: members = [] } = useQuery(membersQuery(c.id));
  const { data: candidates = [] } = useQuery({ ...candidatesQuery(c.id), enabled: admin });
  const { data: session } = useQuery(sessionQuery);
  const queryClient = useQueryClient();
  /** role null = remove. */
  const save = async (emails: string[], role: Role | null) => {
    for (const email of emails) await api(`${profilePath(c.id)}/members`, 'POST', { email, role });
    await queryClient.invalidateQueries({ queryKey: ['computers'] });
  };

  return (
    <Section title="People with access" lead="Viewers watch and answer agent requests. Editors also drive and change logins, playbooks and domains. Admins also share and delete the profile.">
      <Panel>
        <Table>
          <TableHeader><TableRow><TableHead>Member</TableHead><TableHead>Role</TableHead>{admin && <TableHead><span className="sr-only">Actions</span></TableHead>}</TableRow></TableHeader>
          <TableBody>{members.map((m) => (
            <TableRow key={m.email}>
              <TableCell>{m.email}{m.email === session?.email && <span className="text-ink-3"> (you)</span>}</TableCell>
              <TableCell>{admin ? <RoleSelect email={m.email} role={m.role} onChange={(role) => save([m.email], role)} /> : label(m.role)}</TableCell>
              {admin && <TableCell className="w-px text-right">{m.email !== session?.email && <ActionButton variant="outline" size="sm" action={() => save([m.email], null)}>Remove</ActionButton>}</TableCell>}
            </TableRow>
          ))}</TableBody>
        </Table>
      </Panel>
      {admin && <AddMembers candidates={candidates} onAdd={save} />}
    </Section>
  );
}

function RoleSelect({ email, role, onChange }: { email: string; role: Role; onChange: (role: Role) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // Controlled by the server's answer: the select shows the new role once saved, the old one on error.
  return (
    <select className={selectClass} aria-label={`Role of ${email}`} value={role} disabled={busy} onChange={async (e) => {
      setBusy(true);
      try { await onChange(e.target.value as Role); } catch (err) { toast.error(message(err)); } finally { setBusy(false); }
    }}>
      {ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}
    </select>
  );
}

function AddMembers({ candidates, onAdd }: { candidates: string[]; onAdd: (emails: string[], role: Role) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOpen(!picked.length);
    if (!picked.length) return;
    setBusy(true);
    try { await onAdd(picked, new FormData(e.currentTarget).get('role') as Role); setPicked([]); }
    catch (err) { toast.error(message(err)); } finally { setBusy(false); }
  };
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <div className="flex flex-col gap-1.5 text-[13px] font-medium">Add members
        <details className="relative min-w-[220px]" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="flex h-8 cursor-pointer list-none items-center rounded-lg border border-input bg-card px-3 text-sm font-normal text-foreground after:ml-auto after:pl-3 after:text-ink-3 after:content-['▾']">
            {picked.length ? `${picked.length} selected` : 'Choose'}
          </summary>
          <div className="absolute top-[calc(100%+4px)] left-0 z-10 flex max-h-60 min-w-full flex-col gap-2 overflow-auto rounded-lg border bg-card px-3 py-2.5 shadow-lg">
            {candidates.length ? candidates.map((email) => (
              <label key={email} className="flex cursor-pointer items-center gap-2.5 text-sm font-normal text-foreground">
                <input type="checkbox" name="email" value={email} className="size-4 accent-ink" checked={picked.includes(email)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, email] : picked.filter((x) => x !== email))} />{email}
              </label>
            )) : <Hint>Everyone already has access.</Hint>}
          </div>
        </details>
      </div>
      <label className="flex flex-col gap-1.5 text-[13px] font-medium">Role
        <select name="role" className={selectClass} defaultValue="viewer">{ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select>
      </label>
      <Button type="submit" disabled={busy}>Add</Button>
    </form>
  );
}
