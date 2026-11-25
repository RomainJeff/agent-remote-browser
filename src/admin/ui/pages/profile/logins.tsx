import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { useFormAction } from '@/components/form-message';
import { Empty, Panel, Section, Sub } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { detailsQuery, profilePath } from '@/lib/queries';
import type { Login } from '@/lib/types';

type Draft = Partial<Pick<Login, 'site' | 'url' | 'username'>>;

export function LoginsTab({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const queryClient = useQueryClient(), p = profilePath(id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['computers'] });
  // The form opens on Add login (empty) or Replace (that login, password to type again).
  const [draft, setDraft] = useState<Draft | null>(null);
  const logins = data?.logins ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Section title="Saved logins" lead="The agent signs in with these. Passwords are encrypted and never shown again, to you or the agent."
        actions={!draft && <Button onClick={() => setDraft({})}>Add login</Button>}>
        <Panel>
          {!logins.length ? <Empty>No saved logins. Add one, or sign in by hand with Take over: the cookies stay in the profile.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead>Site</TableHead><TableHead>Username</TableHead><TableHead>Password</TableHead><TableHead>Last test</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
              <TableBody>{logins.map((l) => (
                <TableRow key={l.site}>
                  <TableCell><span className="font-medium">{l.site}</span><Sub mono>{l.url}</Sub></TableCell>
                  <TableCell>{l.username}</TableCell>
                  <TableCell aria-label="Saved" className="text-ink-3">••••••••</TableCell>
                  <TableCell className="whitespace-nowrap">{l.lastTestedAt
                    ? <>{l.lastResult === 'ok' ? 'Form submitted' : <span className="font-medium">Failed</span>}<Sub>{ago(l.lastTestedAt)}</Sub></>
                    : <span className="text-ink-3">Never tested</span>}</TableCell>
                  <TableCell className="w-px text-right whitespace-nowrap">
                    <span className="inline-flex gap-2">
                      <ActionButton variant="outline" size="sm" action={async () => {
                        const r = await api<{ ok: boolean; url?: string }>(`${p}/login-test`, 'POST', { site: l.site });
                        await refresh();
                        // ok = the form was filled and submitted, not that the site accepted it: the page URL tells.
                        if (r.ok) toast(`${l.site}: form submitted. Page: ${r.url || 'unknown'}. Check the view to confirm.`);
                        else toast.error(`${l.site}: fill failed. Page: ${r.url || 'unknown'}`);
                      }}>Test</ActionButton>
                      <Button variant="outline" size="sm" onClick={() => setDraft({ site: l.site, url: l.url, username: l.username })}>Replace</Button>
                      <ActionButton variant="outline" size="sm" done={`Saved login ${l.site} deleted.`} action={async () => {
                        if (!await confirmSensitive({ title: `Delete saved login "${l.site}"?`, desc: 'The agent can no longer sign in with it. Existing cookies stay.', label: 'Delete', danger: true })) return false;
                        await api(`${p}/login-delete`, 'POST', { site: l.site });
                        await refresh();
                      }}>Delete</ActionButton>
                    </span>
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </Panel>
      </Section>
      {draft && <LoginForm key={draft.site ?? ''} id={id} draft={draft} onDone={() => setDraft(null)} />}
    </div>
  );
}

function LoginForm({ id, draft, onDone }: { id: string; draft: Draft; onDone: () => void }) {
  const queryClient = useQueryClient(), replace = !!draft.site;
  const save = useFormAction(async (d) => {
    const site = String(d.get('site')).trim();
    await api(`${profilePath(id)}/login-save`, 'POST', { site, url: String(d.get('url')).trim(), username: d.get('username'), password: d.get('password') });
    await queryClient.invalidateQueries({ queryKey: ['computers'] });
    toast(`Saved login ${site}.`);
    onDone(); // the form closes: its own status line goes with it
    return '';
  });
  return (
    <Section title={replace ? `Replace ${draft.site}` : 'Add login'}>
      <form className="grid max-w-[720px] grid-cols-2 gap-x-4 gap-y-3 max-[600px]:grid-cols-1" onSubmit={save.onSubmit}>
        <Field><FieldLabel htmlFor="lsite">Site</FieldLabel><Input id="lsite" name="site" className="font-mono" placeholder="notion" pattern="[a-z0-9\-]{1,40}" title="Lowercase letters, digits and hyphens, 40 max" required autoComplete="off" autoFocus={!replace} readOnly={replace} defaultValue={draft.site} /></Field>
        <Field><FieldLabel htmlFor="lurl">Sign-in URL</FieldLabel><Input id="lurl" name="url" className="font-mono" placeholder="https://www.notion.so/login" required autoComplete="off" defaultValue={draft.url} /></Field>
        <Field><FieldLabel htmlFor="luser">Username</FieldLabel><Input id="luser" name="username" required autoComplete="off" defaultValue={draft.username} /></Field>
        <Field><FieldLabel htmlFor="lpass">Password</FieldLabel><Input id="lpass" name="password" type="password" placeholder={replace ? 'Leave empty to keep the current one' : ''} autoComplete="new-password" autoFocus={replace} /></Field>
        <div className="col-span-full flex flex-wrap items-center gap-2">
          <Button type="submit" size="lg" disabled={save.busy}>Save</Button>
          <Button type="button" variant="ghost" size="lg" onClick={onDone}>Cancel</Button>
          {save.status}
        </div>
      </form>
    </Section>
  );
}
