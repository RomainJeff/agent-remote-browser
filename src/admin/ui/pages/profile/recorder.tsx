import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Hint, Panel } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { plural } from '@/lib/format';
import { recorder, useLive } from '@/lib/live';
import { canSave, recBody } from '@/lib/record';
import { openInEditor } from './playbooks';

/** The recording of this profile: its steps, which fills become params, outputs, Replay and Save. */
export function Recorder({ id }: { id: string }) {
  useLive();
  const navigate = useNavigate(), g = recorder.rec;
  const [read, setRead] = useState({ selector: '', contains: '' });
  if (g?.id !== id) return null;
  const output = (e: FormEvent) => {
    e.preventDefault();
    const selector = read.selector.trim(), contains = read.contains.trim();
    recorder.read({ ...(selector && { selector }), ...(contains && { contains }) });
  };
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
              <code className="font-mono [overflow-wrap:anywhere]">{JSON.stringify(s.step)}</code>
              {s.step.fill && <>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" className="accent-primary" checked={!!s.param} onChange={(e) => { s.param = e.target.checked; recorder.edited(); }} /> Param
                </label>
                <Input className="h-7 w-[140px] font-mono" aria-label="Param name" value={s.pname ?? ''} onChange={(e) => { s.pname = e.target.value.trim(); recorder.edited(); }} />
              </>}
              <Button variant="danger-outline" size="sm" className="ml-auto" onClick={() => { g.steps.splice(i, 1); recorder.edited(); }}>Remove</Button>
            </li>
          ))}
        </ol>
      ) : <Hint>No steps yet.</Hint>}
      <form className="flex flex-wrap gap-2" onSubmit={output}>
        <Input className="min-w-0 flex-[1_1_100%] font-mono" placeholder="Output: CSS selector (optional)" autoComplete="off" value={read.selector} onChange={(e) => setRead({ ...read, selector: e.target.value })} />
        <Input className="min-w-0 flex-[1_1_120px]" placeholder="or text it contains" autoComplete="off" value={read.contains} onChange={(e) => setRead({ ...read, contains: e.target.value })} />
        <Button type="submit" variant="outline" size="sm" className="h-9">Add output</Button>
      </form>
      <div className="flex flex-wrap gap-2">
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
