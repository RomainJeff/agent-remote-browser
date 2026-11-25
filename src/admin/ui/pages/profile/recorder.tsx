import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { XIcon } from 'lucide-react';
import { InputToken, StepText } from '@/components/step-text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { plural } from '@/lib/format';
import { recorder, useLive } from '@/lib/live';
import { describeStep } from '@/lib/playbook';
import { canSave, recBody } from '@/lib/record';
import { openInEditor } from './playbooks';

/** The recording of this profile, in the session rail: its steps, which typed values become inputs, outputs, Replay and Save. */
export function Recorder({ id }: { id: string }) {
  useLive();
  const navigate = useNavigate(), g = recorder.rec;
  const [read, setRead] = useState<{ selector: string; contains: string } | null>(null);
  if (g?.id !== id) return null;
  const output = (e: FormEvent) => {
    e.preventDefault();
    const selector = read!.selector.trim(), contains = read!.contains.trim();
    recorder.read({ ...(selector && { selector }), ...(contains && { contains }) });
    setRead(null);
  };
  const inputs = [...new Set(g.steps.filter((s) => s.step.fill && s.param && s.pname).map((s) => s.pname!))];

  return (
    <section className="flex min-w-0 flex-col" aria-label="Recording">
      <div className="flex items-center gap-2.5 pb-3">
        <h2 className="flex-auto text-sm font-semibold">New playbook</h2>
        <Button variant="outline" size="sm" onClick={() => recorder.stop()}>Stop</Button>
      </div>
      <ol className="border-t border-line-soft">
        {g.steps.map((s, i) => (
          <Step key={i} n={i + 1} remove={() => { g.steps.splice(i, 1); recorder.edited(); }}>
            <StepText parts={describeStep(s.step)} />
            {s.step.fill && (
              <span className="mt-2 flex items-center gap-2 text-[13px] text-ink-2">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" className="accent-ink" checked={!!s.param} onChange={(e) => { s.param = e.target.checked; recorder.edited(); }} />Input
                </label>
                <Input className="h-[26px] w-auto min-w-0 flex-1 px-2 font-mono text-[12.5px]" aria-label={`Input name, step ${i + 1}`} disabled={!s.param}
                  value={s.pname ?? ''} onChange={(e) => { s.pname = e.target.value.trim(); recorder.edited(); }} />
              </span>
            )}
          </Step>
        ))}
        {/* What has not become a step yet, as the last row. */}
        <Pending>
          {g.pick ? <span className="flex flex-col gap-2">
              Password field. Which saved login?
              <span className="flex flex-wrap gap-1.5">
                {g.pick.map((x) => <Button key={x.site} variant="outline" size="sm" title={x.site} onClick={() => recorder.pick(x.site)}>{x.username}</Button>)}
                <Button variant="ghost" size="sm" onClick={() => recorder.cancelPick()}>Cancel</Button>
              </span>
            </span>
            : g.lost ? 'Typing is off until a click goes through: the focus may still be on the previous field.'
            : g.buf ? `Typing ${plural(g.buf.length, 'character')}, sent on the next click or Enter`
            : !g.steps.length ? 'Click, type and press Enter in the view: each gesture becomes a step.' : null}
        </Pending>
      </ol>
      <div className="mt-2 flex flex-col gap-3 border-t pt-3.5">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <span className="flex flex-auto flex-wrap items-center gap-1.5">{inputs.length > 0 && <>Inputs {inputs.map((n) => <InputToken key={n} name={n} />)}</>}</span>
          {!read && <Button variant="outline" size="sm" onClick={() => setRead({ selector: '', contains: '' })}>Add output…</Button>}
        </div>
        {read && (
          <form className="flex flex-col gap-2" onSubmit={output} aria-label="Add output">
            <Input className="font-mono" placeholder="CSS selector (optional)" aria-label="CSS selector" autoComplete="off" autoFocus value={read.selector} onChange={(e) => setRead({ ...read, selector: e.target.value })} />
            <Input placeholder="or text it contains" aria-label="Text it contains" autoComplete="off" value={read.contains} onChange={(e) => setRead({ ...read, contains: e.target.value })} />
            <span className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setRead(null)}>Cancel</Button>
              <Button type="submit" variant="outline" size="sm">Add output</Button>
            </span>
          </form>
        )}
        {g.out && <pre aria-live="polite" className="max-h-[200px] overflow-auto rounded-lg border bg-surface-2 p-2.5 font-mono text-xs leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere]">{g.out}</pre>}
        <div className="flex gap-2">
          {/* Replay runs the draft through run_playbook's path, the typed values as inputs. Replay and Save take the draft
              once the gestures before them (and the typing buffer) went through. */}
          <Button variant="outline" className="flex-1" disabled={!canSave(g)} onClick={() => recorder.replay()}>Replay</Button>
          {/* Saving goes through the playbook form: same playbook-save, same 2FA step-up. */}
          <Button className="flex-1" disabled={!canSave(g)} onClick={() => recorder.withBuf(async (g) => {
            openInEditor(recBody(g).body);
            await navigate({ to: '/profiles/$id', params: { id: g.id }, search: { tab: 'playbooks' } });
          }, true)}>Save as playbook…</Button>
        </div>
      </div>
    </section>
  );
}

function Step({ n, remove, children }: { n: number; remove: () => void; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)_24px] items-start gap-2.5 border-b border-line-soft py-2.5 text-[13.5px] leading-5">
      <i className="grid size-[22px] place-items-center rounded-full bg-line-soft text-[11.5px] font-semibold not-italic tabular-nums">{n}</i>
      <span className="min-w-0">{children}</span>
      <Button variant="ghost" size="icon-xs" className="text-ink-3" aria-label={`Remove step ${n}`} onClick={remove}><XIcon /></Button>
    </li>
  );
}

function Pending({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <li aria-live="polite" className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 py-2.5 text-[13.5px] leading-5 text-ink-2">
      <i className="size-[22px] rounded-full border border-dashed border-line-strong" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}
