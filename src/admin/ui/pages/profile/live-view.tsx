import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CrosshairIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ActionButton } from '@/components/action-button';
import { askNote } from '@/components/confirm';
import { ControlFrame, ControlTab, driverLabel, driverOf, LeaseClock } from '@/components/state';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { leftMin, message, plural } from '@/lib/format';
import { closeView, drawn, live, loading, openView, recorder, send, setNote, setOpening, startRecording, takeControl, takeOver, useLive } from '@/lib/live';
import { detailsQuery, profilePath } from '@/lib/queries';
import type { Computer } from '@/lib/types';
import { cn } from '@/lib/utils';

const originOf = (u?: string) => { try { return new URL(u!).origin; } catch { return null; } };

export function LiveView({ c }: { c: Computer }) {
  const l = useLive(), queryClient = useQueryClient(), p = profilePath(c.id);
  const { data: details } = useQuery(detailsQuery(c.id));
  const takeOverRef = useRef<HTMLButtonElement>(null);
  const [filling, setFilling] = useState(false);
  // Under an agent lease the server drops live input unless the admin took the agent's request.
  const h = c.handoff, locked = !!c.leasedUntil && h?.state !== 'taken';
  const up = c.state === 'running', viewer = c.role === 'viewer';
  const view = l.view?.id === c.id ? l.view : null, frame = l.frame?.id === c.id ? l.frame : null, ctl = !!view?.control, recording = recorder.rec?.id === c.id;
  const lost = !!view?.control && (locked || (viewer && h?.state !== 'taken'));
  useEffect(() => { if (lost) openView(c.id, false); }, [lost, c.id]);
  useEffect(() => { if (live.focusTakeOver) { live.focusTakeOver = false; takeOverRef.current?.focus(); } }, []);
  const refresh = () => queryClient.refetchQueries({ queryKey: ['computers'] });
  const driver = driverOf(c, { control: ctl, recording }), choosing = recording ? recorder.rec!.choosing : null;

  /** Done / Failed (or Decline): the agent reads the outcome and the note on its next handoff_status. Ends control. */
  const endHandoff = (how: 'done' | 'fail', title?: string) => async () => {
    const note = await askNote(how === 'done'
      ? { title: 'Hand back to the agent?', desc: 'Its browser tools work again. Tell it what you did, if useful.', label: 'Done', note: 'optional' }
      : { title: title || 'Tell the agent it failed?', desc: 'Its browser tools work again. It reads your note.', label: 'Send', danger: true, note: 'required' });
    if (note === null) return false;
    await api(`${p}/handoff-${how}`, 'POST', { note });
    if (live.view?.id === c.id) openView(c.id, false);
    await refresh();
  };

  /** Takeover: the server fills the page on screen (the password never reaches this page). */
  const fill = (site: string) => async () => {
    setFilling(true);
    try {
      const r = await api<{ ok: boolean; reason?: string }>(`${p}/login-fill`, 'POST', { site });
      if (r.ok) return toast(`${site}: form submitted. Check the view.`);
      toast.error(r.reason === 'origin' ? `The page is no longer on ${originOf(details?.logins.find((x) => x.site === site)?.url) ?? 'the site of this login'}: nothing was filled.`
        : 'No form found (it needs visible username and password fields). Nothing was submitted.');
    } finally { setFilling(false); document.getElementById('frame')?.focus(); }
  };

  // Saved logins for the page's exact origin (never a parent domain: SSO pages need their own login).
  const here = !viewer && ctl && view?.url ? (details?.logins ?? []).filter((x) => originOf(x.url) === originOf(view.url)) : [];
  const caption = l.note ?? (ctl ? `${viewer ? 'Keyboard and mouse go' : 'Keyboard, mouse and copy/paste go'} to the browser` : '');
  const take = (label: string) => (
    <ActionButton ref={takeOverRef} size="sm" action={() => takeOver(queryClient, c.id)}>{label}</ActionButton>
  );

  return (
    <section className="flex min-w-0 flex-col" aria-label="Live view">
      {h && (
        <RequestBanner reason={h.reason} left={leftMin(h.deadline)}>
          {h.state === 'pending' ? <>
            <ActionButton variant="outline" size="sm" action={endHandoff('fail', "Decline the agent's request?")} done="The agent can continue.">Decline…</ActionButton>
            {take('Take over')}
          </> : <>
            {!ctl && take('Take over')}
            <ActionButton variant="outline" size="sm" action={endHandoff('fail')} done="The agent can continue.">Failed…</ActionButton>
            <ActionButton size="sm" variant={ctl ? 'default' : 'outline'} action={endHandoff('done')} done="The agent can continue.">Done</ActionButton>
          </>}
        </RequestBanner>
      )}
      {/* Wrapped buttons go above the tab, so the tab stays on its frame. */}
      <div className="flex flex-wrap-reverse items-start gap-x-3 gap-y-2">
        <ControlTab driver={driver}>{choosing ? <><CrosshairIcon className="size-3.5" />{choosing === 'text' ? 'Picking an output' : 'Picking an area'}</>
          : <>{driverLabel(driver, c, ctl)}{driver === 'agent' && <LeaseClock until={c.leasedUntil!} />}</>}</ControlTab>
        <span aria-live="polite" className={cn('flex-[1_1_160px] pb-2 text-[13px]', choosing ? 'text-ink-2' : 'text-ink-3')}>
          {choosing ? `${choosing === 'text' ? 'Click the text to read.' : 'Click inside the area to keep.'} Nothing is clicked on the page.` : caption}
        </span>
        <div className="flex flex-wrap gap-2 pb-1.5">
          {!!c.leasedUntil && !viewer && <>
            <ActionButton variant="outline" size="sm" done="Lease extended to at least 30 min from now." action={async () => { await api(`${p}/extend`, 'POST', { minutes: 30 }); await refresh(); }}>Extend 30 min</ActionButton>
            <ActionButton variant="outline" size="sm" done="Lease released. The agent has to take a new one." action={async () => { await api(`${p}/release`, 'POST'); await refresh(); }}>Release lease</ActionButton>
          </>}
          {ctl && <Button variant="outline" size="sm" onClick={() => openView(c.id, false)}>Hand back</Button>}
          {!view && (up || viewer) && (
            <ActionButton variant="outline" size="sm" title="Watch without sending input"
              action={async () => { if (up) openView(c.id, false); else await takeControl(queryClient, c.id, false); }}>{up ? 'Watch' : 'Start and watch'}</ActionButton>
          )}
          {!ctl && !h && !locked && !viewer && take(up ? 'Take over' : 'Start and take over')}
          {!viewer && !recording && !(locked && !h) && (
            <ActionButton variant="outline" size="sm" title="Take over and record your gestures as a playbook" action={() => startRecording(queryClient, c.id)}>Record playbook</ActionButton>
          )}
          {view && <Button variant="outline" size="sm" onClick={() => { closeView(); takeOverRef.current?.focus(); }}>Leave view</Button>}
        </div>
      </div>
      <ControlFrame driver={driver}>
        {!viewer && (
          <UrlBar c={c} url={view?.url}>
            {here.length > 0 && (
              <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                {here.length === 1 ? `Saved login, ${here[0].username}` : 'Saved logins'}
                {here.map((x) => (
                  <ActionButton key={x.site} size="xs" title={`Fill and submit ${x.site}`} action={fill(x.site)}>{here.length === 1 ? 'Fill and submit' : `${x.site}, ${x.username}`}</ActionButton>
                ))}
              </span>
            )}
          </UrlBar>
        )}
        <div className={cn('screen relative min-h-[120px] overflow-hidden bg-surface-2', loading() && 'loading')}>
          {frame && <Frame c={c} src={frame.src} seq={frame.seq} control={ctl} hidden={!!view && !view.seen} />}
          {(!frame || (view && !view.seen)) && (view
            ? <NoSignal title="Connecting…">Waiting for the first image of the page.</NoSignal>
            : <NoSignal title="No signal">Watch shows a running browser.</NoSignal>)}
          {filling && <div className="absolute inset-0 grid place-items-center bg-ink/60 p-4 text-center font-semibold text-white">The server is filling the form… do not touch the view</div>}
        </div>
      </ControlFrame>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-2.5 text-[12.5px] text-ink-3">
        {details?.page ? <>
          <span className="text-ink-2">{details.page.title || 'Untitled page'}</span>
          <span className="min-w-0 flex-[1_1_200px] truncate font-mono text-xs">{details.page.url}</span>
        </> : <span className="flex-auto">Browser stopped</span>}
        {c.viewers > 0 && <span>{plural(c.viewers, 'viewer')}</span>}
        {l.fps && <span className="tabular-nums">{l.fps}</span>}
      </div>
    </section>
  );
}

/** An agent asks for a person. The reason is the agent's words (untrusted): quoted, never phrased as an instruction from this page. */
function RequestBanner({ reason, left, children }: { reason: string; left: number; children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-xl border border-needs-you-line bg-needs-you-soft px-3.5 py-3">
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
        <b className="font-semibold">An agent asked for help</b>
        <q className="text-[13.5px] [overflow-wrap:anywhere] text-needs-you-ink">{reason}</q>
      </div>
      <span className="text-[13px] text-needs-you-ink tabular-nums">{left} min left</span>
      {children}
    </div>
  );
}

function NoSignal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid h-[clamp(200px,36vh,360px)] place-items-center p-5 text-center text-ink-3">
      <div><b className="mb-1 block text-[15px] font-semibold text-ink">{title}</b>{children}</div>
    </div>
  );
}

/** The address bar on top of the frame. children: what sits at its end (saved logins for the page). */
function UrlBar({ c, url, children }: { c: Computer; url?: string; children?: ReactNode }) {
  const queryClient = useQueryClient(), input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  // The address follows the page, except while the admin types in it.
  useEffect(() => { if (url !== undefined && document.activeElement !== input.current) setValue(url === 'about:blank' ? '' : url); }, [url]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let u = value.trim();
    if (!u || busy) return;
    if (!/^https?:\/\//.test(u)) u = 'https://' + u;
    if (recorder.rec?.id === c.id) return recorder.open(u);
    setBusy(true); setNote('Opening…'); setOpening(true);
    try {
      await api(`${profilePath(c.id)}/open`, 'POST', { url: u }); // `open` returns once the page fired load
      if (live.view?.id === c.id) setNote(null); else openView(c.id, false);
      await queryClient.invalidateQueries({ queryKey: ['computers', c.id] });
    } catch (err) { setNote(message(err)); }
    finally { setOpening(false); setBusy(false); }
  };
  return (
    <form className="flex min-h-[38px] flex-wrap items-center gap-2 border-b bg-surface-2 py-1 pr-1.5 pl-3 has-[input:focus-visible]:bg-surface has-[input:focus-visible]:ring-[3px] has-[input:focus-visible]:ring-ring/50 has-[input:focus-visible]:ring-inset" onSubmit={submit}>
      <label htmlFor="vurl" className="sr-only">Address</label>
      <input ref={input} id="vurl" className="h-7 min-w-0 flex-[1_1_200px] bg-transparent font-mono text-[12.5px] outline-none placeholder:text-ink-3"
        placeholder="https://… (allowed domains only)" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      {loading() && <span className="size-4 flex-none animate-spin rounded-full border-2 border-line border-t-ink" title="Page loading"><span className="sr-only">Page loading</span></span>}
      {children}
    </form>
  );
}

// Human input -> agent-browser stream protocol (same fields as its own dashboard).
// The remote Chrome runs on Linux: on a Mac, Cmd is sent as Ctrl so Cmd+A, Cmd+Z... behave as expected.
const MAC = /Mac|iP/.test(navigator.platform);
const mods = (e: MouseEvent | KeyboardEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey || (MAC && e.metaKey) ? 2 : 0) | (!MAC && e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const KEY_TEXT: Record<string, string> = { Enter: '\r', Tab: '\t' };
const button = (b: number) => ['left', 'middle', 'right'][b] || 'none';

/** The last frame. With control, mouse, keys and the clipboard go to the browser; while recording, clicks and keys
 *  go to the gateway as steps instead (the wheel still scrolls). Native listeners: the wheel needs preventDefault. */
function Frame({ c, src, seq, control, hidden }: { c: Computer; src: string; seq: number; control: boolean; hidden: boolean }) {
  const img = useRef<HTMLImageElement>(null), viewer = c.role === 'viewer';
  useEffect(() => {
    const el = img.current!, id = c.id;
    if (!control) return;
    el.focus();
    const recording = () => recorder.rec?.id === id;
    // Map onto the frame itself, not metadata.deviceHeight: that is the window (720), the frame only the page (633),
    // so y scaled by deviceHeight lands too low. deviceWidth / naturalWidth converts frame pixels to CSS pixels.
    const pos = (e: MouseEvent) => {
      const r = el.getBoundingClientRect(), w = el.naturalWidth || r.width, h = el.naturalHeight || r.height;
      const css = (live.view?.meta?.deviceWidth || w) / w;
      return { x: Math.round((e.clientX - r.left) * w / r.width * css), y: Math.round((e.clientY - r.top) * h / r.height * css) };
    };
    const mouse = (eventType: string, e: MouseEvent, extra: object = {}) => send({ type: 'input_mouse', eventType, ...pos(e), button: button(e.button), clickCount: e.detail || 1, modifiers: mods(e), ...extra });
    let lastMove = 0;
    const kb = (eventType: string, e: KeyboardEvent) => {
      const cmd = (e.ctrlKey || e.metaKey) && !e.altKey; // shortcuts type nothing (AltGr = Ctrl+Alt still does)
      const text = eventType === 'keyDown' && !cmd ? (KEY_TEXT[e.key] ?? ([...e.key].length === 1 ? e.key : undefined)) : undefined;
      send({ type: 'input_keyboard', eventType, key: e.key, code: e.code, text, windowsVirtualKeyCode: e.keyCode, modifiers: mods(e) });
    };
    // Clipboard: the remote Chrome has its own, so copy/paste go through the gateway instead of keystrokes.
    const copyRemote = () => api<{ text?: string }>(`${profilePath(id)}/copy`, 'POST', {})
      .then(async (r) => { if (!r.text) return void toast.error('Nothing selected.'); await navigator.clipboard.writeText(r.text); toast('Copied to your clipboard.'); })
      .catch((err) => toast.error(`Copy failed: ${message(err)}`));
    const key = (eventType: 'keyDown' | 'keyUp') => (e: KeyboardEvent) => {
      const sc = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase();
      if (sc === 'v') return; // no preventDefault: the browser fires `paste` below with the local clipboard
      e.preventDefault();
      if (recording()) return eventType === 'keyDown' && recorder.key(e);
      if (sc === 'c' || sc === 'x') {
        if (eventType === 'keyDown' && !viewer) copyRemote().then(() => { if (sc === 'x') { kb('keyDown', e); kb('keyUp', e); } });
        return;
      }
      kb(eventType, e);
    };
    const on: Record<string, (e: any) => void> = {
      mousedown: (e: MouseEvent) => { e.preventDefault(); el.focus(); if (!recording()) mouse('mousePressed', e); },
      mouseup: (e: MouseEvent) => { if (!recording()) return mouse('mouseReleased', e); if (e.button === 0) recorder.click(pos(e)); },
      mousemove: (e: MouseEvent) => {
        if (recording() || (Date.now() - lastMove < 40 && !e.buttons)) return;
        lastMove = Date.now();
        mouse('mouseMoved', e, { button: e.buttons ? 'left' : 'none', clickCount: 0 });
      },
      contextmenu: (e: MouseEvent) => e.preventDefault(),
      wheel: (e: WheelEvent) => { e.preventDefault(); mouse('mouseWheel', e, { button: 'none', clickCount: 0, deltaX: e.deltaX, deltaY: e.deltaY }); },
      keydown: key('keyDown'), keyup: key('keyUp'),
      paste: (e: ClipboardEvent) => {
        e.preventDefault();
        if (viewer) return;
        const t = e.clipboardData?.getData('text/plain') ?? '';
        if (recording()) return recorder.addBuf(t);
        if (t.length > 5000) return toast.error('Text too long (5000 characters max).');
        if (t) api(`${profilePath(id)}/paste`, 'POST', { text: t }).catch((err) => toast.error(`Paste failed: ${message(err)}`));
      },
    };
    for (const [type, fn] of Object.entries(on)) el.addEventListener(type, fn, { passive: false });
    return () => { for (const [type, fn] of Object.entries(on)) el.removeEventListener(type, fn); };
  }, [control, c.id, viewer]);
  return (
    <img ref={img} id="frame" tabIndex={0} alt="Live view of the browser" src={src} hidden={hidden} draggable={false}
      onLoad={() => drawn(seq)} className={cn('block h-auto w-full select-none focus:outline-none', control && 'cursor-crosshair')} />
  );
}
