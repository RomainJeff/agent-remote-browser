import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { Alert, Empty, Hint, Panel } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, message } from '@/lib/format';
import { ACTIONS, DEFAULTS, LOCATORS, WAITS, parse, placeholders, serialize, toolName, type Action, type Fields, type Model, type Row } from '@/lib/playbook';
import { detailsQuery, profilePath } from '@/lib/queries';
import type { Login } from '@/lib/types';
import { cn } from '@/lib/utils';

const TIPS: Partial<Record<Action, string>> = {
  click: 'Prefer text, label or role: refs go stale after a navigation, CSS breaks.', fill: 'Prefer label or placeholder. Put a {param} in the value.',
  wait: 'text is case-sensitive. url is a glob over the whole URL, e.g. **/manage*.', login: 'Wait for networkidle first. No-op when the page has no password field.',
  get_text: 'Empty = the whole page. Otherwise the lines containing this word, case-insensitive.', snapshot: 'Empty = the whole page. A CSS selector, e.g. main.',
};
const EMPTY: Model = { desc: '', notes: '', steps: [], fallback: '' };
const control = 'h-8 rounded-lg border border-input bg-card px-2.5 font-mono text-[13px]';

export function PlaybooksTab({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const queryClient = useQueryClient(), p = profilePath(id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['computers', id] });
  const [draft, setDraft] = useState({ name: '', body: '', key: 0, notice: '' });
  const books = data?.playbooks ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Alert>Notes for the agent, read with the <code>playbook</code> tool and followed as written: only you can write them. Fill the form, or write the Markdown yourself: both stay in sync.</Alert>
      <Panel title="Playbooks" aside={<Hint>Saving or deleting asks for your 2FA code</Hint>}>
        {!books.length ? <Empty>No playbooks. Write one below: how to do a known task on a site, step by step.</Empty> : (
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Description</TableHead><TableHead>Updated</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>{books.map((b) => (
              <TableRow key={b.name}>
                <TableCell className="font-mono font-semibold whitespace-nowrap">{b.name}</TableCell>
                <TableCell>{b.description}</TableCell>
                <TableCell className="whitespace-nowrap">{ago(b.updated)}</TableCell>
                <TableCell className="w-px text-right whitespace-nowrap">
                  <Button variant="outline" size="sm" onClick={() => setDraft((d) => ({ name: b.name, body: b.body, key: d.key + 1, notice: '' }))}>Edit</Button>{' '}
                  <ActionButton variant="danger-outline" size="sm" done={`Playbook ${b.name} deleted.`} action={async () => {
                    if (!await confirmSensitive({ title: `Delete playbook "${b.name}"?`, desc: 'The agent no longer sees it.', label: 'Delete', danger: true })) return false;
                    await api(`${p}/playbook-delete`, 'POST', { name: b.name });
                    await refresh();
                  }}>Delete</ActionButton>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </Panel>
      <Panel pad title="Add or replace">
        {/* Remounted on Edit and after a save: the editor starts from that body. */}
        <Editor key={draft.key} initial={draft} logins={data?.logins ?? []} onSave={async (name, body) => {
          const r = await api<{ created: boolean }>(`${p}/playbook-save`, 'POST', { name, body });
          await refresh();
          setDraft((d) => ({ name: '', body: '', key: d.key + 1, notice: r.created ? 'Created.' : 'Updated.' }));
        }} />
      </Panel>
    </div>
  );
}

/** The form edits the model and rewrites the Markdown (what is saved); editing the Markdown redraws the form. */
/** initial.notice: the outcome of the save that reset the editor, shown for 3 s. */
function Editor({ initial, logins, onSave }: { initial: { name: string; body: string; notice: string }; logins: Login[]; onSave: (name: string, body: string) => Promise<void> }) {
  const [name, setName] = useState(initial.name);
  const [body, setBody] = useState(initial.body);
  const [model, setModel] = useState<Model>(() => { const m = parse(initial.body); return 'err' in m ? EMPTY : m; });
  const [mode, setMode] = useState<'form' | 'md'>('form');
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(initial.notice ? { text: initial.notice, error: false } : null);
  useEffect(() => { if (!initial.notice) return; const t = setTimeout(() => setMsg(null), 3000); return () => clearTimeout(t); }, [initial.notice]);
  const [busy, setBusy] = useState(false);
  // Bumped when steps move or go: rows remount, so a JSON row's textarea never shows another step's text.
  const [gen, setGen] = useState(0);
  const parsed = parse(body), err = 'err' in parsed ? parsed.err : '';
  const edit = (m: Model) => { setModel(m); setBody(serialize(m)); };
  const editMd = (md: string) => { setBody(md); const m = parse(md); if (!('err' in m)) { setModel(m); setGen((g) => g + 1); } };
  const setStep = (i: number, r: Row) => edit({ ...model, steps: model.steps.map((x, j) => j === i ? r : x) });

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    // Success remounts the editor (empty, with the notice): only an error stays here.
    try { await onSave(name.trim(), body); } catch (x) { setMsg({ text: message(x), error: true }); setBusy(false); }
  };
  const tool = toolName(name.trim() || 'name'), params = placeholders(body), n = 'err' in parsed ? 0 : parsed.steps.length, kb = new Blob([body]).size / 1024;

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor="bname">Name</FieldLabel>
        <Input id="bname" name="name" className="font-mono" placeholder="check-quota" pattern="[a-z0-9][a-z0-9\-]{0,39}" required autoComplete="off" spellCheck={false}
          title="Lowercase letters, digits and hyphens, 40 max. Starts with a letter or digit." value={name} onChange={(e) => setName(e.target.value)} />
        <FieldDescription>Lowercase, digits and dashes. Becomes the tool <code className="font-mono">{tool}</code></FieldDescription>
      </Field>
      <fieldset className="flex flex-wrap gap-1.5" aria-label="Edit as">
        {(['form', 'md'] as const).map((m) => (
          <label key={m} className="relative">
            <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="peer absolute opacity-0" />
            <span className="inline-flex h-9 cursor-pointer items-center rounded-full border px-3.5 font-semibold peer-checked:border-primary peer-checked:bg-secondary peer-checked:text-primary peer-focus-visible:outline-2 peer-focus-visible:outline-primary">
              {m === 'form' ? 'Form' : 'Markdown'}
            </span>
          </label>
        ))}
      </fieldset>
      {mode === 'form' ? (
        <>
          {err && <Alert kind="warn">The Markdown has an error, so the form is paused: {err}</Alert>}
          <fieldset disabled={!!err} className="flex min-w-0 flex-col gap-4 disabled:opacity-45">
            <Field>
              <FieldLabel htmlFor="bdesc">Description</FieldLabel>
              <Input id="bdesc" maxLength={200} autoComplete="off" placeholder="Check the executions quota of an n8n Cloud workspace" value={model.desc} onChange={(e) => edit({ ...model, desc: e.target.value })} />
              <FieldDescription>Line 1. The agent picks the playbook from it: say the task, not the site.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="bnotes">Notes for the agent</FieldLabel>
              <textarea id="bnotes" rows={3} className="rounded-lg border border-input px-3 py-2.5" placeholder="What to fill in, what the result means." value={model.notes} onChange={(e) => edit({ ...model, notes: e.target.value })} />
            </Field>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between"><span className="text-xs font-bold text-muted-foreground">Steps · {model.steps.length} of 20</span><Hint>Run in one call, 18 s at most</Hint></div>
              <ol className="flex flex-col gap-2">
                {model.steps.map((r, i) => (
                  <StepRow key={`${gen}-${i}`} row={r} i={i} n={model.steps.length} logins={logins} onChange={(x) => setStep(i, x)}
                    onMove={(to) => { const s = [...model.steps]; [s[i], s[to]] = [s[to], s[i]]; edit({ ...model, steps: s }); setGen(gen + 1); }}
                    onDelete={() => { edit({ ...model, steps: model.steps.filter((_, j) => j !== i) }); setGen(gen + 1); }} />
                ))}
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => { const a: Action = model.steps.length ? 'click' : 'open'; edit({ ...model, steps: [...model.steps, { a, f: { ...DEFAULTS[a] } }] }); }}>+ Add step</Button>
                <Hint>Write <code className="font-mono">{'{word}'}</code> in a field: the agent fills it in.</Hint>
              </div>
              {params.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                  <span className="text-xs font-bold text-muted-foreground">The agent fills</span>
                  {params.map((x) => <span key={x} className="rounded-full bg-agent-soft px-2 font-mono text-xs leading-[18px] text-agent-ink">{`{${x}}`}</span>)}
                  <Hint>→ <code className="font-mono">{tool}({params.join(', ')})</code></Hint>
                </div>
              )}
            </div>
            <Field>
              <FieldLabel htmlFor="bfallback">If it fails</FieldLabel>
              <textarea id="bfallback" rows={2} className="rounded-lg border border-input px-3 py-2.5" placeholder="If step 3 fails, call request_human." value={model.fallback} onChange={(e) => edit({ ...model, fallback: e.target.value })} />
              <FieldDescription>Sent back with the error and the failed step number.</FieldDescription>
            </Field>
          </fieldset>
        </>
      ) : (
        <textarea name="body" aria-label="Playbook Markdown" spellCheck={false} placeholder="# Check the n8n quota of a workspace" value={body} onChange={(e) => editMd(e.target.value)}
          className="min-h-[420px] rounded-lg border border-input p-3 font-mono text-[13px] leading-5" />
      )}
      {body.trim() && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
          <span>Agent sees <b className="font-semibold text-foreground">{name.trim() || 'name'}</b>: {'err' in parsed ? '' : parsed.desc || <Ko>no description</Ko>}</span>
          <span>{err ? <Ko>Recipe not readable</Ko> : n > 20 ? <Ko>{n} steps, 20 max</Ko> : n ? <><span className="font-semibold text-ok">✓ Recipe</span> {n} steps</> : 'No recipe: the agent reads it and acts step by step'}</span>
          <span className={cn(kb > 20 && 'font-semibold text-destructive-ink')}>{kb.toFixed(1)} KB of 20</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="lg" disabled={busy}>Save</Button>
        <p aria-live="polite" className={cn('min-h-5 text-[13px] text-muted-foreground', msg?.error && 'font-semibold text-destructive-ink')}>{msg?.text}</p>
      </div>
    </form>
  );
}

const Ko = ({ children }: { children: React.ReactNode }) => <span className="font-semibold text-destructive-ink">{children}</span>;

function StepRow({ row, i, n, logins, onChange, onMove, onDelete }: {
  row: Row; i: number; n: number; logins: Login[]; onChange: (r: Row) => void; onMove: (to: number) => void; onDelete: () => void;
}) {
  const label = `step ${i + 1}`;
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg border border-muted bg-[#FAFBFB] p-2.5 max-[600px]:grid-cols-[20px_minmax(0,1fr)]">
      <span className="grid h-10 place-items-center font-mono text-[13px] font-bold text-muted-foreground">{i + 1}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {'raw' in row ? (
            <textarea rows={2} spellCheck={false} aria-label={`Step ${i + 1} as JSON`} defaultValue={row.raw}
              className="flex-[1_1_100%] rounded-lg border border-input px-3 py-2 font-mono text-[13px] leading-[18px]"
              onChange={(e) => { let raw = e.target.value; try { raw = JSON.stringify(JSON.parse(raw)); } catch {} onChange({ raw }); }} />
          ) : (
            <>
              <select aria-label="Action" className={cn(control, 'font-semibold text-primary')} value={row.a}
                onChange={(e) => { const a = e.target.value as Action; onChange({ a, f: { ...DEFAULTS[a] } }); }}>
                {Object.keys(ACTIONS).map((a) => <option key={a}>{a}</option>)}
              </select>
              <StepFields a={row.a} f={row.f} logins={logins} onChange={(f) => onChange({ a: row.a, f })} />
            </>
          )}
        </div>
        <Hint className="mt-1.5 block">{'raw' in row ? 'Shown as JSON: the form has no field for some of its options.' : ACTIONS[row.a] + (TIPS[row.a] ? '. ' + TIPS[row.a] : '')}</Hint>
      </div>
      <div className="flex gap-0.5 max-[600px]:col-start-2">
        <Button type="button" variant="ghost" size="sm" aria-label={`Move ${label} up`} disabled={!i} onClick={() => onMove(i - 1)}>↑</Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`Move ${label} down`} disabled={i === n - 1} onClick={() => onMove(i + 1)}>↓</Button>
        <Button type="button" variant="ghost" size="sm" className="text-destructive-ink" aria-label={`Delete ${label}`} onClick={onDelete}>✕</Button>
      </div>
    </li>
  );
}

function StepFields({ a, f, logins, onChange }: { a: Action; f: Fields; logins: Login[]; onChange: (f: Fields) => void }) {
  const set = (patch: Fields) => onChange({ ...f, ...patch });
  const input = (k: 'v' | 'name' | 'value', placeholder: string) => (
    <input className={cn(control, 'min-w-0 flex-[1_1_140px] max-[600px]:flex-[1_1_100%]')} placeholder={placeholder} aria-label={placeholder} autoComplete="off" spellCheck={false}
      value={f[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })} />
  );
  const check = (k: 'keep' | 'if_needed', label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-[13px]"><input type="checkbox" className="size-4 accent-primary" checked={!!f[k]} onChange={(e) => set({ [k]: e.target.checked })} />{label}</label>
  );
  const select = (label: string, options: string[], value: string | undefined, change: (v: string) => void) => (
    <select aria-label={label} className={control} value={value} onChange={(e) => change(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select>
  );
  // Changing what to find by (or wait for) clears the value: it means something else now.
  const kind = (label: string, options: string[]) => select(label, options, f.kind, (k) => set({ kind: k, v: a === 'wait' && k === 'load' ? 'networkidle' : '' }));
  const locator = () => <>{kind('Find by', LOCATORS)}{input('v', ({ role: 'button', ref: '@e3', css: '#usage .total' } as Record<string, string>)[f.kind!] ?? 'Text on the page')}{f.kind === 'role' && input('name', 'Accessible name')}</>;

  switch (a) {
    case 'open': return input('v', 'https://…');
    case 'login': {
      // The profile's saved logins; a name not (or no longer) saved stays selectable, marked, so editing never drops it.
      const sites = logins.map((l) => l.site);
      return <>
        <select aria-label="Saved login" className={control} value={f.v ?? ''} onChange={(e) => set({ v: e.target.value })}>
          <option value="">{sites.length ? 'Pick a saved login' : 'No saved login: add one in Logins'}</option>
          {f.v && !sites.includes(f.v) && <option value={f.v}>{f.v} (not saved)</option>}
          {logins.map((l) => <option key={l.site} value={l.site}>{l.site} · {l.username}</option>)}
        </select>
        {check('if_needed', 'Skip if signed in')}
      </>;
    }
    case 'click': return locator();
    case 'fill': return <>{locator()}{input('value', 'Value, e.g. {email}')}</>;
    case 'press': return input('v', 'Enter, Tab, Escape…');
    case 'wait': return <>{kind('Wait for', WAITS)}{f.kind === 'load'
      ? select('State', ['load', 'domcontentloaded', 'networkidle'], f.v, (v) => set({ v }))
      : input('v', ({ text: 'Executions', url: '**/manage*', selector: '#usage', ms: '1000 (5000 max)' } as Record<string, string>)[f.kind!])}</>;
    case 'get_text': return <>{input('v', 'Lines containing… (optional)')}{check('keep', 'Return it')}</>;
    case 'snapshot': return <>{input('v', 'Scope, CSS (optional)')}{check('keep', 'Return it')}</>;
    default: return null;
  }
}
