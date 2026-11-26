import { Menu } from '@base-ui/react/menu';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Crosshair, List } from 'lucide-react';
import { Hint, Panel } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { plural } from '@/lib/format';
import { recorder, useLive } from '@/lib/live';
import { canSave, larger, recBody, type RecStep } from '@/lib/record';
import { openInEditor } from './playbooks';

/** The recording of this profile: its steps, which fills become params, outputs, Replay and Save. */
export function Recorder({ id }: { id: string }) {
  useLive();
  const navigate = useNavigate(), g = recorder.rec;
  if (g?.id !== id) return null;
  let outputs = 0;
  return (
    <Panel pad title={<span className="flex items-center gap-2"><span className="flex-auto">Recording</span><Button variant="outline" size="sm" onClick={() => recorder.stop()}>Stop</Button></span>}>
      <Hint>Click, type and press Enter in the view: each gesture runs as a playbook step. Typing is sent on the next click, or on Enter, Tab or Escape. In a password field, the site's saved login is used instead.</Hint>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {g.pick ? <>Several saved logins for this site, use: {g.pick.map((x) => (
          <Button key={x.site} variant="outline" size="sm" className="mr-1" onClick={() => recorder.pick(x.site)}>{x.site} ({x.username})</Button>
        ))}<Button variant="outline" size="sm" onClick={() => recorder.cancelPick()}>Cancel</Button></>
          : g.lost ? 'Typing is off until a click goes through: the focus may still be on the previous field'
          : g.buf ? `Typing: ${plural(g.buf.length, 'character')}, sent on the next click or Enter` : ''}
      </p>
      {g.steps.length ? (
        <ol className="flex flex-col gap-2.5 text-[13px]">
          {g.steps.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              {s.step.get_text || s.step.snapshot ? <Output s={s} n={++outputs} />
                : <code className="font-mono [overflow-wrap:anywhere]">{JSON.stringify(s.step)}</code>}
              {s.step.fill && <>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" className="accent-primary" checked={!!s.param} onChange={(e) => { s.param = e.target.checked; recorder.edited(); }} /> Param
                </label>
                <Input className="h-7 w-[140px] font-mono" aria-label="Param name" value={s.pname ?? ''} onChange={(e) => { s.pname = e.target.value.trim(); recorder.edited(); }} />
              </>}
              <Button variant="danger-outline" size="sm" className="ml-auto" onClick={() => { g.steps.splice(i, 1); if (g.choosing === s) g.choosing = null; recorder.edited(); }}>Remove</Button>
            </li>
          ))}
        </ol>
      ) : <Hint>No steps yet.</Hint>}
      <div className="flex flex-wrap gap-2">
        {g.choosing
          ? <Button variant="secondary" size="sm" aria-pressed onClick={() => recorder.choose(null)}>Cancel pick</Button>
          : <AddOutput />}
        {/* Replay runs the draft through run_playbook's path, the typed values as params. Replay and Save take the draft
            once the gestures before them (and the typing buffer) went through. */}
        <Button variant="outline" size="sm" disabled={!canSave(g)} onClick={() => recorder.replay()}>Replay</Button>
        {/* Saving goes through the playbook form: same playbook-save, same 2FA step-up. */}
        <Button size="sm" disabled={!canSave(g)} onClick={() => recorder.withBuf(async (g) => {
          openInEditor(recBody(g).body);
          await navigate({ to: '/profiles/$id', params: { id: g.id }, search: { tab: 'playbooks' } });
        }, true)}>Save as playbook…</Button>
      </div>
      {g.out && <pre className="max-h-[200px] overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{g.out}</pre>}
    </Panel>
  );
}

/** Add output: a value picked in the view, or a snapshot of the page (an area of it is picked from its row). */
function AddOutput() {
  const item = 'grid w-full cursor-default grid-cols-[18px_minmax(0,1fr)] items-start gap-2.5 rounded-md px-3 py-2.5 text-left text-[13px] outline-none data-highlighted:bg-muted';
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button variant="outline" size="sm" />}>Add output<ChevronDown /></Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Menu.Popup className="flex w-[300px] flex-col gap-0.5 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
            <Menu.Item className={item} onClick={() => recorder.choose('text')}>
              <Crosshair className="mt-px size-[18px] text-primary" />
              <span><b className="block font-semibold">Text on the page</b><span className="text-muted-foreground">Pick a value: a total, a status, a date</span></span>
            </Menu.Item>
            <Menu.Item className={item} onClick={() => recorder.snapshot()}>
              <List className="mt-px size-[18px] text-primary" />
              <span><b className="block font-semibold">Page snapshot</b><span className="text-muted-foreground">Links, buttons and fields the agent can act on next</span></span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const PREVIEW = 4;

/** An output row: what it read when recorded; a snapshot's area can be picked, widened or dropped. */
function Output({ s, n }: { s: RecStep; n: number }) {
  const out = <span className="text-muted-foreground"> · Output {n}</span>;
  if (s.step.get_text) return (
    <span className="flex min-w-0 flex-auto flex-col gap-1">
      <span>Read <code className="rounded bg-muted px-1 font-mono [overflow-wrap:anywhere]">{(s.text ?? '').slice(0, 200)}</code>{out}</span>
      <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.step.get_text.selector}</code>
    </span>
  );
  const scope: string | undefined = s.step.snapshot.scope, up = scope && larger(scope), lines = (s.text ?? '').split('\n');
  return (
    <span className="flex min-w-0 flex-auto flex-col gap-1.5">
      <span>{scope ? 'Snapshot of an area' : 'Snapshot of the page'}{out}</span>
      {scope && <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{scope}</code>}
      <pre className="overflow-hidden rounded-md border border-muted bg-background px-2.5 py-2 font-mono text-[11.5px] leading-[17px] text-muted-foreground">
        {lines.slice(0, PREVIEW).join('\n')}{lines.length > PREVIEW && <><br /><i>… {lines.length - PREVIEW} more</i></>}
      </pre>
      <span className="flex flex-wrap gap-1.5">
        {!scope ? <Button variant="link" size="xs" className="px-0" onClick={() => recorder.choose(s)}>Limit to an area</Button> : <>
          {up && <Button variant="outline" size="xs" onClick={() => recorder.snapshot(up, s)}>Larger area</Button>}
          <Button variant="outline" size="xs" onClick={() => recorder.snapshot(undefined, s)}>Whole page</Button>
        </>}
      </span>
    </span>
  );
}
