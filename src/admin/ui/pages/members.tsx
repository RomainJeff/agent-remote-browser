import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { FormError } from '@/components/auth-layout';
import { confirmSensitive } from '@/components/confirm';
import { CopyButton } from '@/components/mcp-url';
import { Avatar, PageHead } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { message, plural } from '@/lib/format';
import { invitesQuery, usersQuery } from '@/lib/queries';
import { sessionQuery } from '@/lib/session';
import type { GatewayUser } from '@/lib/types';

type Link = { title: string; url: string; note: string };
const ROLES = [['member', 'Member', 'Uses the profiles shared with them.'], ['admin', 'Admin', 'Also invites and removes members.']] as const;
const roleName = (admin: boolean) => admin ? 'Admin' : 'Member';

/** Gateway members (the route lets only gateway admins in), and the invites not used yet, in one table. */
export function MembersPage() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: users = [] } = useQuery(usersQuery);
  const { data: invites = [] } = useQuery(invitesQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<Link | null>(null);
  // An invited email has a pending account until the invite is used: its invite row stands for it.
  const invited = new Set(invites.map((i) => i.email));
  const members = users.filter((u) => !(u.pending && invited.has(u.email)));

  return (
    <>
      <PageHead title="Members" actions={<Button onClick={() => setInviting(true)}>Invite member</Button>} />
      {/* Edge to edge in the main panel, right under the header bar. */}
      <div className="-mx-6 -mt-6 max-[700px]:-mx-4 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Member</TableHead><TableHead>Role</TableHead><TableHead>Two-step sign-in</TableHead>
            <TableHead><span className="sr-only">Actions</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {members.map((u) => <MemberRow key={u.email} u={u} you={u.email === session?.email} refresh={refresh} onLink={setLink} />)}
            {invites.map((i) => (
              <TableRow key={i.id} className="text-ink-2">
                <TableCell><span className="flex items-center gap-3"><Avatar email={i.email} invited />{i.email}</span></TableCell>
                <TableCell>{roleName(i.admin)}</TableCell>
                <TableCell title={new Date(i.expires).toLocaleString()}>Invited, link expires in {Math.max(1, Math.ceil((i.expires - Date.now()) / 3600000))} h</TableCell>
                <TableCell className="w-px text-right">
                  <ActionButton variant="outline" size="sm" action={async () => {
                    await api(`/api/users/invites/${encodeURIComponent(i.id)}/revoke`, 'POST');
                    await refresh();
                  }}>Revoke invite</ActionButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <InviteDialog open={inviting} onClose={() => setInviting(false)} onLink={(l) => { setInviting(false); setLink(l); }} />
      {/* The link is shown once: closing the dialog drops it. */}
      <Dialog open={!!link} onOpenChange={(open) => { if (!open) setLink(null); }}>
        {link && (
          <DialogContent showCloseButton={false} className="flex flex-col gap-4 p-[22px] sm:max-w-[460px]">
            <div className="flex flex-col gap-1">
              <DialogTitle className="text-base font-semibold">{link.title}</DialogTitle>
              <DialogDescription>{link.note}</DialogDescription>
            </div>
            <div className="flex gap-2"><Input className="font-mono" aria-label={link.title} readOnly value={link.url} onFocus={(e) => e.target.select()} /><CopyButton text={link.url} /></div>
            <div className="flex justify-end"><Button size="lg" onClick={() => setLink(null)}>Done</Button></div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function MemberRow({ u, you, refresh, onLink }: { u: GatewayUser; you: boolean; refresh: () => Promise<void>; onLink: (l: Link) => void }) {
  return (
    <TableRow className={u.pending ? 'text-ink-2' : ''}>
      <TableCell><span className="flex items-center gap-3"><Avatar email={u.email} invited={u.pending} /><span>{u.email}{you && <span className="text-ink-3"> (you)</span>}</span></span></TableCell>
      <TableCell>
        {you || u.pending ? roleName(u.admin) : (
          <select aria-label={`Role of ${u.email}`} className="h-[30px] rounded-lg border border-input bg-card px-2 text-[13.5px]" value={u.admin ? 'admin' : 'member'}
            onChange={async (e) => {
              try { await api('/api/users/admin', 'POST', { email: u.email, admin: e.target.value === 'admin' }); }
              catch (err) { toast.error(message(err)); }
              await refresh();
            }}>
            {ROLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        )}
      </TableCell>
      <TableCell className={u.twoFactorEnabled ? '' : 'text-ink-2'}>{u.pending ? 'Invite expired' : u.twoFactorEnabled ? 'On' : 'Not set up yet'}</TableCell>
      <TableCell className="w-px text-right whitespace-nowrap">
        {!u.pending && (
          <span className="inline-flex gap-2">
            <ActionButton variant="outline" size="sm" action={async () => {
              const r = await api<{ link: string }>('/api/users/reset-link', 'POST', { email: u.email });
              onLink({ title: 'Password reset link', url: r.link, note: `Send it to ${u.email}. It works once.` });
            }}>Reset password</ActionButton>
            {!you && <>
              <ActionButton variant="outline" size="sm" action={async () => {
                if (!await confirmSensitive({ title: `Remove ${u.email}?`, desc: `Permanently deletes ${plural(u.privateProfileCount, 'private profile')}. Shared profiles stay.`, danger: true, label: 'Remove' })) return false;
                await api('/api/users/remove', 'POST', { email: u.email });
                await refresh();
              }}>Remove…</ActionButton>
            </>}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Email and role, then the one-time link replaces the form. */
function InviteDialog({ open, onClose, onLink }: { open: boolean; onClose: () => void; onLink: (l: Link) => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget), email = String(data.get('email')).trim();
    setBusy(true);
    try {
      const r = await api<{ link: string }>('/api/users/invite', 'POST', { email, admin: data.get('role') === 'admin' });
      setError('');
      onLink({ title: 'Invite link', url: r.link, note: `Send it to ${email}. It works once, for 24 hours.` });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setError(''); onClose(); } }}>
      {open && (
        <DialogContent showCloseButton={false} className="p-0 sm:max-w-[460px]">
          <form className="flex flex-col gap-4 p-[22px]" onSubmit={submit}>
            <DialogTitle className="text-base font-semibold">Invite member</DialogTitle>
            <Field><FieldLabel htmlFor="inviteEmail">Email</FieldLabel><Input id="inviteEmail" name="email" type="email" required autoFocus /></Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-[13px] font-medium">Role</legend>
              {ROLES.map(([v, label, desc]) => (
                <label key={v} className="flex cursor-pointer gap-2.5 rounded-lg border p-3 has-checked:border-ink">
                  <input type="radio" name="role" value={v} defaultChecked={v === 'member'} className="mt-0.5 accent-ink" />
                  <span className="flex flex-col gap-0.5"><b className="font-semibold">{label}</b><span className="text-[13px] text-ink-2">{desc}</span></span>
                </label>
              ))}
            </fieldset>
            <FormError>{error}</FormError>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="lg" onClick={onClose}>Cancel</Button>
              <Button type="submit" size="lg" disabled={busy}>Create invite link</Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
