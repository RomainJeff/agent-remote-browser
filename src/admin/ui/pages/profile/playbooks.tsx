import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { Alert, Hint, Section } from '@/components/page';
import { InputToken, NumberedStep, StepText } from '@/components/step-text';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { ago, message } from '@/lib/format';
import { ACTIONS, DEFAULTS, LOCATORS, WAITS, describeStep, parse, placeholders, serialize, toStep, toolName, type Action, type Fields, type Model, type Row } from '@/lib/playbook';
import { startRecording } from '@/lib/live';
import { detailsQuery, profilePath } from '@/lib/queries';
import type { Login } from '@/lib/types';
import { cn } from '@/lib/utils';

const TIPS: Partial<Record<Action, string>> = {
  click: 'Prefer text, label or role: refs go stale after a navigation, CSS breaks.', fill: 'Prefer label or placeholder. Put a {param} in the value.',
  wait: 'text is case-sensitive. url is a glob over the whole URL, e.g. **/manage*.', login: 'Wait for networkidle first. No-op when the page has no password field.',
  get_text: 'Empty = the whole page. Otherwise the lines containing this word, case-insensitive.', snapshot: 'Empty = the whole page. A CSS selector, e.g. main.',
};
// A recording saved from the session tab: the editor of the next playbooks tab starts from it.
let incoming: string | null = null;
export const openInEditor = (body: string) => { incoming = body; };

const EMPTY: Model = { desc: '', notes: '', steps: [], fallback: '' };
const control = 'h-8 rounded-lg border border-input bg-card px-2.5 font-mono text-[13px]';

type Draft = { name: string; body: string; key: number };

export function PlaybooksTab({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const queryClient = useQueryClient(), p = profilePath(id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['computers', id] });
  const navigate = useNavigate();
  // The editor is open on New playbook, Edit, or a recording saved from the session tab.
  const [draft, setDraft] = useState<Draft | null>(() => { const body = incoming; incoming = null; return body ? { name: '', body, key: 0 } : null; });
  const [sel, setSel] = useState<string | null>(null);
  const books = data?.playbooks ?? [], current = books.find((b) => b.name === sel) ?? books[0];
  const open = (name: string, body: string) => setDraft((d) => ({ name, body, key: (d?.key ?? 0) + 1 }));

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-8 max-[900px]:grid-cols-1">
      <div className="flex flex-col gap-1">
        <div className="mb-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => open('', '')}>New playbook</Button>
          <ActionButton variant="outline" size="sm" action={async () => {
            await navigate({ to: '/profiles/$id', params: { id } });
            await startRecording(queryClient, id);
          }}>Record playbook</ActionButton>
        </div>
        <nav aria-label="Playbooks" className="flex flex-col gap-0.5">
          {books.map((b) => (
            <button key={b.name} type="button" aria-current={!draft && current?.name === b.name ? 'page' : undefined} onClick={() => { setSel(b.name); setDraft(null); }}
              className="flex cursor-pointer flex-col rounded-lg px-2.5 py-2 text-left hover:bg-line-soft aria-[current=page]:bg-line">
              <b className="font-mono text-[13px] font-semibold [overflow-wrap:anywhere]">{b.name}</b>
              <span className="text-[12.5px] text-ink-3">Updated {ago(b.updated)}</span>
            </button>
          ))}
        </nav>
        {!books.length && !draft && <p className="px-2.5 text-[13px] text-ink-3">No playbooks yet: how to do a known task on a site, step by step.</p>}
      </div>
      {draft ? (
        <Section title={draft.name ? <>Edit <span className="font-mono">{draft.name}</span></> : 'New playbook'}
          lead={<>Notes for the agent, read with the <code className="font-mono text-[12.5px]">playbook</code> tool and followed as written: only you can write them.</>}
          actions={<Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>}>
          {/* Remounted on each New or Edit: the editor starts from that body. */}
          <Editor key={draft.key} initial={draft} logins={data?.logins ?? []} onSave={async (name, body) => {
            const r = await api<{ created: boolean }>(`${p}/playbook-save`, 'POST', { name, body });
            await refresh();
            setDraft(null); setSel(name);
            toast(`Playbook ${name} ${r.created ? 'created' : 'updated'}.`);
          }} />
        </Section>
      ) : current && (
        <Section title={<span className="font-mono">{current.name}</span>} lead={current.description}
          actions={<>
            <Button variant="outline" onClick={() => open(current.name, current.body)}>Edit</Button>
            <ActionButton variant="outline" done={`Playbook ${current.name} deleted.`} action={async () => {
              if (!await confirmSensitive({ title: `Delete playbook ${current.name}?`, desc: 'The agent no longer sees it.', label: 'Delete', danger: true })) return false;
              await api(`${p}/playbook-delete`, 'POST', { name: current.name });
              setSel(null);
              await refresh();
            }}>Delete</ActionButton>
          </>}>
          <Recipe body={current.body} />
        </Section>
      )}
    </div>
  );
}

/** A saved playbook as the agent will follow it: its inputs, notes, steps as sentences, and what to do if it fails. */
function Recipe({ body }: { body: string }) {
  const m = parse(body), inputs = placeholders(body);
  if ('err' in m) return <p className="text-ink-2">The recipe can't be read: {m.err} Edit it to fix it.</p>;
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      {inputs.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2">Inputs {inputs.map((n) => <InputToken key={n} name={n} />)}</div>}
      {m.notes && <p className="whitespace-pre-wrap text-ink-2">{m.notes}</p>}
      {m.steps.length ? (
        <ol className="border-t border-line-soft">
          {m.steps.map((r, i) => <NumberedStep key={i} n={i + 1}><StepText parts={describeStep('raw' in r ? JSON.parse(r.raw) : toStep(r))} /></NumberedStep>)}
        </ol>
      ) : <p className="text-ink-3">No recipe: the agent reads the notes and acts step by step.</p>}
      {m.fallback && <p className="whitespace-pre-wrap"><span className="font-medium">If it fails: </span><span className="text-ink-2">{m.fallback}</span></p>}
    </div>
  );
}

/** The form edits the model and rewrites the Markdown (what is saved); editing the Markdown redraws the form. */
function Editor({ initial, logins, onSave }: { initial: { name: string; body: string }; logins: Login[]; onSave: (name: string, body: string) => Promise<void> }) {
  const [name, setName] = useState(initial.name);
  const [body, setBody] = useState(initial.body);
  const [model, setModel] = useState<Model>(() => { const m = parse(initial.body); return 'err' in m ? EMPTY : m; });
  const [mode, setMode] = useState<'form' | 'md'>('form');
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
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
    // Success closes the editor: only an error stays here.
    try { await onSave(name.trim(), body); } catch (x) { setMsg({ text: message(x), error: true }); setBusy(false); }
  };
  const tool = toolName(name.trim() || 'name'), params = placeholders(body), n = 'err' in parsed ? 0 : parsed.steps.length, kb = new Blob([body]).size / 1024;

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor="bname">Name</FieldLabel>
        <Input id="bname" name="name" className="font-mono" placeholder="check-quota" pattern="[a-z0-9][a-z0-9\-]{0,39}" required autoComplete="off" spellCheck={false}
          title="Lowercase letters, digits and hyphens, 40 max. Starts with a letter or digit." autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <FieldDescription>Lowercase, digits and dashes. Becomes the tool <code className="font-mono">{tool}</code></FieldDescription>
      </Field>
      <fieldset className="flex flex-wrap gap-1.5" aria-label="Edit as">
        {(['form', 'md'] as const).map((m) => (
          <label key={m} className="relative">
            <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="peer absolute opacity-0" />
            <span className="inline-flex h-9 cursor-pointer items-center rounded-lg border px-3.5 font-medium peer-checked:border-ink peer-checked:bg-line-soft peer-checked:text-ink peer-focus-visible:outline-2 peer-focus-visible:outline-primary">
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
              <div className="flex justify-between"><span className="text-[13px] font-medium">Steps <span className="font-normal text-ink-3">{model.steps.length} of 20</span></span><Hint>Run in one call, 18 s at most</Hint></div>
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
                  <span className="text-ink-2">Inputs</span>
                  {params.map((x) => <InputToken key={x} name={x} />)}
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
          <span>{err ? <Ko>Recipe not readable</Ko> : n > 20 ? <Ko>{n} steps, 20 max</Ko> : n ? `Recipe, ${n} steps` : 'No recipe: the agent reads it and acts step by step'}</span>
          <span className={cn(kb > 20 && 'font-medium text-ink')}>{kb.toFixed(1)} KB of 20</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="lg" disabled={busy}>Save</Button>
        <p aria-live="polite" className={cn('min-h-5 text-[13px] text-muted-foreground', msg?.error && 'font-medium text-ink')}>{msg?.text}</p>
      </div>
    </form>
  );
}

const Ko = ({ children }: { children: React.ReactNode }) => <span className="font-medium text-ink">{children}</span>;

function StepRow({ row, i, n, logins, onChange, onMove, onDelete }: {
  row: Row; i: number; n: number; logins: Login[]; onChange: (r: Row) => void; onMove: (to: number) => void; onDelete: () => void;
}) {
  const label = `step ${i + 1}`;
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg border border-muted bg-surface-2 p-2.5 max-[600px]:grid-cols-[20px_minmax(0,1fr)]">
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
        <Button type="button" variant="ghost" size="sm" className="text-ink-3" aria-label={`Delete ${label}`} onClick={onDelete}>✕</Button>
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
          {logins.map((l) => <option key={l.site} value={l.site}>{l.site}, {l.username}</option>)}
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
