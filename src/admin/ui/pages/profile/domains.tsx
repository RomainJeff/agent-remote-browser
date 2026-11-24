import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { useFormAction } from '@/components/form-message';
import { Alert, Empty, Hint, Panel } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { domains } from '@/lib/format';
import { closeView } from '@/lib/live';
import { detailsQuery, profilePath } from '@/lib/queries';
import type { Computer } from '@/lib/types';

export function DomainsTab({ c }: { c: Computer }) {
  return (
    <div className="flex flex-col gap-4">
      <AllowedDomains c={c} />
      <Headers id={c.id} />
    </div>
  );
}

function AllowedDomains({ c }: { c: Computer }) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const queryClient = useQueryClient();
  const list = draft ?? c.allow;
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem('domain') as HTMLInputElement, more = domains(input.value.toLowerCase());
    if (!more.length) return;
    setDraft([...new Set([...list, ...more])]);
    input.value = '';
  };
  return (
    <Panel pad title="Allowed domains">
      <p className="text-muted-foreground">The agent can only open these domains and their subdomains. Everything else is blocked at the DNS level.</p>
      <div className="flex flex-wrap gap-2">
        {list.length ? list.map((d) => (
          <span key={d} className="inline-flex items-center gap-1 rounded-full border border-info-line bg-secondary py-0.5 pr-1 pl-2.5 font-mono text-[13px] text-primary">
            {d}
            <button type="button" aria-label={`Remove ${d}`} onClick={() => setDraft(list.filter((x) => x !== d))}
              className="size-[22px] cursor-pointer rounded-full text-[15px] leading-none hover:bg-card">×</button>
          </span>
        )) : <Hint>No domains.</Hint>}
      </div>
      <form className="flex gap-2" onSubmit={add}>
        <label htmlFor="newDomain" className="sr-only">Add a domain</label>
        <Input id="newDomain" name="domain" className="font-mono" placeholder="example.com" autoComplete="off" spellCheck={false} />
        <Button type="submit" variant="outline" size="lg">Add</Button>
      </form>
      <Alert kind="warn">Saving restarts this profile's browser: the DNS list is set at launch. An agent in the middle of a task loses its page.</Alert>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton size="lg" done="Domains saved. The browser restarts on next use." action={async () => {
          if (!list.length) throw new Error('Keep at least one domain.');
          closeView();
          try { await api(`${profilePath(c.id)}/config`, 'POST', { allow: list }); setDraft(null); }
          finally { await queryClient.invalidateQueries({ queryKey: ['computers'] }); }
        }}>Save domains</ActionButton>
        {draft && JSON.stringify(draft) !== JSON.stringify(c.allow) && <Hint>Unsaved changes</Hint>}
      </div>
    </Panel>
  );
}

function Headers({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const queryClient = useQueryClient(), p = profilePath(id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['computers', id] });
  const save = useFormAction(async (d) => {
    await api(`${p}/header-save`, 'POST', { origin: String(d.get('origin')).trim(), name: String(d.get('name')).trim(), value: d.get('value') });
    await refresh();
    return 'Saved. Applies from the next page opened on that origin.';
  });
  const headers = data?.headers ?? [];
  return (
    <>
      <Panel title="Custom headers" aside={<Hint>Saving or deleting asks for your 2FA code</Hint>}>
        <div className="px-5 pt-4"><Alert>Sent with every request to one origin once the browser opens a page there (e.g. a staging bypass token). Values are encrypted and never shown again, here or to the agent.</Alert></div>
        {!headers.length ? <Empty>No custom headers.</Empty> : (
          <Table>
            <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Name</TableHead><TableHead>Value</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>{headers.map((h) => (
              <TableRow key={`${h.origin} ${h.name}`}>
                <TableCell className="font-mono">{h.origin}</TableCell>
                <TableCell className="font-mono font-semibold">{h.name}</TableCell>
                <TableCell><Badge variant="secondary">Saved</Badge></TableCell>
                <TableCell className="w-px text-right whitespace-nowrap">
                  <ActionButton variant="danger-outline" size="sm" done={`Header ${h.name} deleted.`} action={async () => {
                    if (!await confirmSensitive({ title: `Delete header "${h.name}"?`, desc: `No longer sent to ${h.origin}. A page already open there keeps it until the browser restarts.`, label: 'Delete', danger: true })) return false;
                    await api(`${p}/header-delete`, 'POST', { origin: h.origin, name: h.name });
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
          <Field><FieldLabel htmlFor="horigin">Origin</FieldLabel><Input id="horigin" name="origin" className="font-mono" placeholder="https://staging.example.com" required autoComplete="off" spellCheck={false} /></Field>
          <Field><FieldLabel htmlFor="hname">Name</FieldLabel><Input id="hname" name="name" className="font-mono" placeholder="X-Bypass-Token" required autoComplete="off" spellCheck={false} /></Field>
          <Field className="col-span-full"><FieldLabel htmlFor="hvalue">Value</FieldLabel><Input id="hvalue" name="value" type="password" className="font-mono" required autoComplete="new-password" /></Field>
          <div className="col-span-full flex flex-wrap items-center gap-2"><Button type="submit" size="lg" disabled={save.busy}>Save</Button>{save.status}</div>
        </form>
      </Panel>
    </>
  );
}
