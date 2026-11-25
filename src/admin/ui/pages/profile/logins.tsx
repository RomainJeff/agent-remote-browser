import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { useFormAction } from '@/components/form-message';
import { Alert, Empty, Hint, Panel, Sub } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { detailsQuery, profilePath } from '@/lib/queries';

export function LoginsTab({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const queryClient = useQueryClient(), p = profilePath(id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['computers'] });
  const save = useFormAction(async (d) => {
    await api(`${p}/login-save`, 'POST', { site: String(d.get('site')).trim(), url: String(d.get('url')).trim(), username: d.get('username'), password: d.get('password') });
    await refresh();
    return 'Saved.';
  });
  const logins = data?.logins ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Alert>Write-only vault. Passwords are encrypted (AES-256-GCM) and never shown again, here or to the agent. The agent calls <code>login</code> with the site name and the form is filled for it.</Alert>
      <Panel title="Saved logins" aside={<Hint>Saving or deleting asks for your 2FA code</Hint>}>
        {!logins.length ? <Empty>No saved logins. Add one below, or sign in by hand with Take over: the cookies stay in the profile.</Empty> : (
          <Table>
            <TableHeader><TableRow><TableHead>Site</TableHead><TableHead>Username</TableHead><TableHead>Password</TableHead><TableHead>Last test</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>{logins.map((l) => (
              <TableRow key={l.site}>
                <TableCell><span className="font-mono font-semibold">{l.site}</span><Sub mono>{l.url}</Sub></TableCell>
                <TableCell>{l.username}</TableCell>
                <TableCell><Badge variant="secondary">Saved</Badge></TableCell>
                <TableCell className="whitespace-nowrap">{l.lastTestedAt
                  ? <>{l.lastResult === 'ok' ? <Badge dot variant="up">Form submitted</Badge> : <Badge variant="danger">Failed</Badge>}<Sub>{ago(l.lastTestedAt)}</Sub></>
                  : <Hint>Never tested</Hint>}</TableCell>
                <TableCell className="w-px text-right whitespace-nowrap">
                  <ActionButton variant="outline" size="sm" action={async () => {
                    const r = await api<{ ok: boolean; url?: string }>(`${p}/login-test`, 'POST', { site: l.site });
                    await refresh();
                    // ok = the form was filled and submitted, not that the site accepted it: the page URL tells.
                    if (r.ok) toast(`${l.site}: form submitted. Page: ${r.url || 'unknown'}. Check the view to confirm.`);
                    else toast.error(`${l.site}: fill failed. Page: ${r.url || 'unknown'}`);
                  }}>Test</ActionButton>{' '}
                  <ActionButton variant="danger-outline" size="sm" done={`Saved login ${l.site} deleted.`} action={async () => {
                    if (!await confirmSensitive({ title: `Delete saved login "${l.site}"?`, desc: 'The agent can no longer sign in with it. Existing cookies stay.', label: 'Delete', danger: true })) return false;
                    await api(`${p}/login-delete`, 'POST', { site: l.site });
                    await refresh();
                  }}>Delete</ActionButton>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </Panel>
      <Panel pad title="Add or replace">
        <form className="grid grid-cols-2 gap-x-4 gap-y-3 max-[600px]:grid-cols-1" onSubmit={save.onSubmit}>
          <Field><FieldLabel htmlFor="lsite">Site</FieldLabel><Input id="lsite" name="site" className="font-mono" placeholder="notion" pattern="[a-z0-9\-]{1,40}" title="Lowercase letters, digits and hyphens, 40 max" required autoComplete="off" /></Field>
          <Field><FieldLabel htmlFor="lurl">Sign-in URL</FieldLabel><Input id="lurl" name="url" className="font-mono" placeholder="https://www.notion.so/login" required autoComplete="off" /></Field>
          <Field><FieldLabel htmlFor="luser">Username</FieldLabel><Input id="luser" name="username" required autoComplete="off" /></Field>
          <Field><FieldLabel htmlFor="lpass">Password</FieldLabel><Input id="lpass" name="password" type="password" placeholder="Leave empty to keep the current one" autoComplete="new-password" /></Field>
          <div className="col-span-full flex flex-wrap items-center gap-2"><Button type="submit" size="lg" disabled={save.busy}>Save</Button>{save.status}</div>
        </form>
      </Panel>
    </div>
  );
}
