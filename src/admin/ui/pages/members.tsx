import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { CopyButton } from '@/components/mcp-url';
import { Empty, PageHead, Panel } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { day, message, plural } from '@/lib/format';
import { invitesQuery, usersQuery } from '@/lib/queries';
import { sessionQuery } from '@/lib/session';

/** Gateway members (the route lets only gateway admins in): roles, removal, invites. */
export function MembersPage() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: users = [] } = useQuery(usersQuery);
  const { data: invites = [] } = useQuery(invitesQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget, data = new FormData(form);
    setBusy(true);
    try {
      const r = await api<{ link: string }>('/api/users/invite', 'POST', { email: String(data.get('email')).trim(), admin: data.get('admin') === 'on' });
      form.reset();
      setLink(r.link);
      await refresh();
    } catch (err) { toast.error(message(err)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title="Members" />
      <Panel>
        <Table>
          <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Gateway admin</TableHead><TableHead>2FA</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{users.map((u) => (
            <TableRow key={u.email}>
              <TableCell>{u.email}</TableCell>
              <TableCell>
                <input type="checkbox" className="size-4 accent-primary" aria-label={`Gateway admin · ${u.email}`} checked={u.admin} disabled={u.pending}
                  onChange={async (e) => {
                    try { await api('/api/users/admin', 'POST', { email: u.email, admin: e.target.checked }); }
                    catch (err) { toast.error(message(err)); }
                    await refresh();
                  }} />
              </TableCell>
              <TableCell>{u.twoFactorEnabled ? 'Enabled' : 'Off'}</TableCell>
              <TableCell>{u.pending ? 'Pending' : 'Active'}</TableCell>
              <TableCell className="w-px text-right whitespace-nowrap">
                {!u.pending && u.email !== session?.email && (
                  <ActionButton variant="outline" size="sm" action={async () => {
                    if (!await confirmSensitive({ title: `Remove ${u.email}?`, desc: `Permanently deletes ${plural(u.privateProfileCount, 'private profile')}.`, danger: true, label: 'Remove' })) return false;
                    await api('/api/users/remove', 'POST', { email: u.email });
                    await refresh();
                  }}>Remove</ActionButton>
                )}
              </TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </Panel>
      <Panel pad title="Invite a member">
        <form className="flex flex-wrap items-end gap-3" onSubmit={invite}>
          <Field className="w-auto flex-[1_1_260px]">
            <FieldLabel htmlFor="inviteEmail">Email</FieldLabel>
            <Input id="inviteEmail" name="email" type="email" required />
          </Field>
          <label className="flex h-9 items-center gap-2"><input type="checkbox" name="admin" className="size-4 accent-primary" />Gateway admin</label>
          <Button type="submit" size="lg" disabled={busy}>Invite</Button>
        </form>
      </Panel>
      <Panel title="Open invites">
        {!invites.length ? <Empty>No open invites.</Empty> : (
          <Table>
            <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Expires</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>{invites.map((i) => (
              <TableRow key={i.id}>
                <TableCell>{i.email}</TableCell>
                <TableCell>{day(i.expires)}</TableCell>
                <TableCell className="w-px text-right"><ActionButton variant="outline" size="sm" action={async () => {
                  await api(`/api/users/invites/${encodeURIComponent(i.id)}/revoke`, 'POST');
                  await refresh();
                }}>Revoke</ActionButton></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </Panel>
      {/* The link is shown once: closing the dialog drops it. */}
      <Dialog open={!!link} onOpenChange={(open) => { if (!open) setLink(null); }}>
        {link && (
          <DialogContent showCloseButton={false} className="flex flex-col gap-4 p-6 sm:max-w-[520px]">
            <DialogTitle className="text-xl font-extrabold">Invite link</DialogTitle>
            <Input className="font-mono" aria-label="Invite link" readOnly value={link} />
            <div className="flex gap-2"><CopyButton text={link} /><Button size="lg" onClick={() => setLink(null)}>Done</Button></div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
