import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { XIcon } from 'lucide-react';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { useFormAction } from '@/components/form-message';
import { Empty, Panel, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { domains, plural } from '@/lib/format';
import { closeView } from '@/lib/live';
import { detailsQuery, profilePath } from '@/lib/queries';
import type { Computer } from '@/lib/types';

export function DomainsTab({ c }: { c: Computer }) {
  return (
    <div className="flex flex-col gap-8">
      <AllowedDomains c={c} />
      <Headers id={c.id} />
    </div>
  );
}

function AllowedDomains({ c }: { c: Computer }) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const queryClient = useQueryClient();
  const list = draft ?? c.allow;
  const changes = draft ? draft.filter((d) => !c.allow.includes(d)).length + c.allow.filter((d) => !draft.includes(d)).length : 0;
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem('domain') as HTMLInputElement, more = domains(input.value.toLowerCase());
    if (!more.length) return;
    setDraft([...new Set([...list, ...more])]);
    input.value = '';
  };
  return (
    <Section title="Allowed domains" lead="The browser only loads these sites and their subdomains. Everything else is blocked at the DNS level.">
      <div className="flex flex-wrap gap-2">
        {list.length ? list.map((d) => (
          <span key={d} className="inline-flex h-[30px] items-center gap-2 rounded-lg border border-line-strong pr-1 pl-2.5 font-mono text-[12.5px]">
            {d}
            <Button variant="ghost" size="icon-xs" className="text-ink-3" aria-label={`Remove ${d}`} onClick={() => setDraft(list.filter((x) => x !== d))}><XIcon /></Button>
          </span>
        )) : <span className="text-ink-3">No domains.</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex min-w-0 flex-[0_1_420px] gap-2" onSubmit={add}>
          <label htmlFor="newDomain" className="sr-only">Add a domain</label>
          <Input id="newDomain" name="domain" className="h-9 font-mono" placeholder="cdn.example.com" autoComplete="off" spellCheck={false} />
          <Button type="submit" variant="outline" size="lg">Add</Button>
        </form>
        <span className="flex-auto" />
        {changes > 0 && <span className="text-[13px] text-ink-2">{plural(changes, 'unsaved change')}</span>}
        <ActionButton size="lg" disabled={!changes} done="Domains saved. The browser restarts on next use." action={async () => {
          if (!list.length) throw new Error('Keep at least one domain.');
          closeView();
          try { await api(`${profilePath(c.id)}/config`, 'POST', { allow: list }); setDraft(null); }
          finally { await queryClient.invalidateQueries({ queryKey: ['computers'] }); }
        }}>Save domains</ActionButton>
      </div>
      {changes > 0 && <p className="text-[13px] text-ink-2">Saving restarts this profile's browser: the DNS list is set at launch. An agent in the middle of a task loses its page.</p>}
    </Section>
  );
}

function Headers({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const queryClient = useQueryClient(), p = profilePath(id);
  const [adding, setAdding] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['computers', id] });
  const save = useFormAction(async (d) => {
    await api(`${p}/header-save`, 'POST', { origin: String(d.get('origin')).trim(), name: String(d.get('name')).trim(), value: d.get('value') });
    await refresh();
    toast('Header saved. It applies from the next page opened on that origin.');
    setAdding(false);
    return '';
  });
  const headers = data?.headers ?? [];
  return (
    <Section title="Custom headers" lead="Sent with every request to one origin, once the browser opens a page there (a staging bypass token, for example). Values are encrypted and never shown again, to you or the agent."
      actions={!adding && <Button variant="outline" onClick={() => setAdding(true)}>Add header</Button>}>
      {(headers.length > 0 || !adding) && (
        <Panel>
          {!headers.length ? <Empty>No custom headers.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Header</TableHead><TableHead>Value</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
              <TableBody>{headers.map((h) => (
                <TableRow key={`${h.origin} ${h.name}`}>
                  <TableCell className="font-mono text-[13px]">{h.origin}</TableCell>
                  <TableCell className="font-mono text-[13px]">{h.name}</TableCell>
                  <TableCell className="text-ink-3">Encrypted</TableCell>
                  <TableCell className="w-px text-right whitespace-nowrap">
                    <ActionButton variant="outline" size="sm" done={`Header ${h.name} deleted.`} action={async () => {
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
      )}
      {adding && (
        <form className="grid max-w-[720px] grid-cols-2 gap-x-4 gap-y-3 max-[600px]:grid-cols-1" onSubmit={save.onSubmit} aria-label="Add header">
          <Field><FieldLabel htmlFor="horigin">Origin</FieldLabel><Input id="horigin" name="origin" className="font-mono" placeholder="https://staging.example.com" required autoComplete="off" spellCheck={false} autoFocus /></Field>
          <Field><FieldLabel htmlFor="hname">Header</FieldLabel><Input id="hname" name="name" className="font-mono" placeholder="X-Bypass-Token" required autoComplete="off" spellCheck={false} /></Field>
          <Field className="col-span-full"><FieldLabel htmlFor="hvalue">Value</FieldLabel><Input id="hvalue" name="value" type="password" className="font-mono" required autoComplete="new-password" /></Field>
          <div className="col-span-full flex flex-wrap items-center gap-2">
            <Button type="submit" size="lg" disabled={save.busy}>Save</Button>
            <Button type="button" variant="ghost" size="lg" onClick={() => setAdding(false)}>Cancel</Button>
            {save.status}
          </div>
        </form>
      )}
    </Section>
  );
}
