import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Menu } from '@base-ui/react/menu';
import { ChevronUpIcon, CrosshairIcon, ListIcon, XIcon } from 'lucide-react';
import { InputToken, NumberedStep, StepText } from '@/components/step-text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { plural } from '@/lib/format';
import { recorder, useLive } from '@/lib/live';
import { describeStep } from '@/lib/playbook';
import { canSave, recBody, type RecStep } from '@/lib/record';
import { openInEditor } from './playbooks';

const isOutput = (s: RecStep) => 'get_text' in s.step || 'snapshot' in s.step;

/** The recording of this profile, in the session rail: its steps, which typed values become inputs, outputs, Replay and Save. */
export function Recorder({ id }: { id: string }) {
  useLive();
  const navigate = useNavigate(), g = recorder.rec;
  if (g?.id !== id) return null;
  const inputs = [...new Set(g.steps.filter((s) => s.step.fill && s.param && s.pname).map((s) => s.pname!))];

  return (
    <section className="flex min-w-0 flex-col" aria-label="Recording">
      <div className="flex items-center gap-2.5 pb-3">
        <h2 className="flex-auto text-sm font-semibold">New playbook</h2>
        <Button variant="outline" size="sm" onClick={() => recorder.stop()}>Stop</Button>
      </div>
      <ol className="border-t border-line-soft">
        {g.steps.map((s, i) => (
          <NumberedStep key={i} n={i + 1} action={<Button variant="ghost" size="icon-xs" className="text-ink-3" aria-label={`Remove step ${i + 1}`} onClick={() => { g.steps.splice(i, 1); if (g.choosing === s) g.choosing = null; recorder.edited(); }}><XIcon /></Button>}>
            {isOutput(s) ? <Output s={s} n={g.steps.slice(0, i + 1).filter(isOutput).length} /> : <StepText parts={describeStep(s.step)} />}
            {s.step.fill && (
              <span className="mt-2 flex items-center gap-2 text-[13px] text-ink-2">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" className="accent-ink" checked={!!s.param} onChange={(e) => { s.param = e.target.checked; recorder.edited(); }} />Input
                </label>
                <Input className="h-[26px] w-auto min-w-0 flex-1 px-2 font-mono text-[12.5px]" aria-label={`Input name, step ${i + 1}`} disabled={!s.param}
                  value={s.pname ?? ''} onChange={(e) => { s.pname = e.target.value.trim(); recorder.edited(); }} />
              </span>
            )}
          </NumberedStep>
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
          {g.choosing
            ? <Button variant="outline" size="sm" aria-pressed onClick={() => recorder.choose(null)}>Cancel pick</Button>
            : <AddOutput />}
        </div>
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

/** "Add output": text picked in the view, or a snapshot of the page. */
function AddOutput() {
  const item = 'grid w-full cursor-default grid-cols-[20px_minmax(0,1fr)] items-start gap-2.5 rounded-md px-3 py-2.5 text-left text-[13px] leading-[18px] outline-none data-highlighted:bg-canvas [&_svg]:mt-px [&_svg]:size-[18px] [&_svg]:text-ink-2';
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button variant="outline" size="sm" />}>Add output<ChevronUpIcon /></Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="flex w-[300px] flex-col gap-0.5 rounded-xl border bg-surface p-1.5 shadow-[0_8px_24px_rgb(21_24_27/.12)] outline-none">
            <Menu.Item className={item} onClick={() => recorder.choose('text')}>
              <CrosshairIcon /><span><b className="block font-semibold">Text on the page</b><span className="text-ink-2">Pick a value: a total, a status, a date</span></span>
            </Menu.Item>
            <Menu.Item className={item} onClick={() => recorder.snapshot()}>
              <ListIcon /><span><b className="block font-semibold">Page snapshot</b><span className="text-ink-2">Links, buttons and fields the agent can act on next</span></span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A recorded output: the value read and where, or a snapshot (of the page or of an area) with its first lines. */
function Output({ s, n }: { s: RecStep; n: number }) {
  const tag = <span className="text-ink-3">, Output {n}</span>, mono = 'font-mono text-[12.5px] text-ink-2 [overflow-wrap:anywhere]';
  if ('get_text' in s.step) {
    const v = (s.text ?? '').trim().split('\n')[0];
    return (
      <span className="flex flex-col gap-1.5">
        <span><StepText parts={['Read ', { val: v.length > 60 ? v.slice(0, 60) + '…' : v || '(empty)' }]} />{tag}</span>
        {s.step.get_text.selector && <span className={mono}>{s.step.get_text.selector}</span>}
      </span>
    );
  }
  const scope: string | undefined = s.step.snapshot.scope, parent = scope?.includes(' > ') && scope.split(' > ').slice(0, -1).join(' > ');
  const lines = (s.text ?? '').split('\n'), more = lines.length - 4;
  return (
    <span className="flex flex-col gap-2">
      <span>{scope ? 'Snapshot of an area' : 'Snapshot of the page'}{tag}</span>
      {scope && <span className={mono}>{scope}</span>}
      <pre className="m-0 overflow-hidden rounded-md border border-line-soft bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] leading-[17px] text-ink-2">
        {lines.slice(0, 4).join('\n')}{more > 0 && <span className="block text-ink-3">… {more}{(s.text ?? '').length >= 2000 && '+'} more</span>}
      </pre>
      {scope
        ? <span className="flex gap-1.5">
            {parent && <Button variant="outline" size="xs" onClick={() => recorder.snapshot(s, parent)}>Larger area</Button>}
            <Button variant="outline" size="xs" onClick={() => recorder.snapshot(s)}>Whole page</Button>
          </span>
        : <span><button type="button" className="text-[13px] text-ink underline underline-offset-2" onClick={() => recorder.choose(s)}>Limit to an area</button></span>}
    </span>
  );
}

function Pending({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <NumberedStep><span aria-live="polite" className="text-ink-2">{children}</span></NumberedStep>;
}
