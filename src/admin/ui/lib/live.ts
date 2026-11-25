// The live view (agent-browser stream protocol) and the recording, kept outside React: they outlive a tab switch
// on the profile page, and the profile list opens the view before navigating to it.
import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from './api';
import { message } from './format';
import { computersQuery, profilePath } from './queries';
import { createRecorder } from './record';

/** since: a navigation started, the view counts as loading until frames settle. seen: a first frame was drawn. */
export type View = {
  id: string; ws: WebSocket; control: boolean; meta: { deviceWidth?: number } | null; frames: number;
  url?: string; seen?: boolean; since?: number; settle?: ReturnType<typeof setTimeout>;
};

/** note: a status to show instead of the view's own (Starting…, an error, View closed). frame: the last image, kept
 *  after the view closes. focusTakeOver: a handoff link asks for Take over to get the focus. */
export const live = {
  view: null as View | null,
  frame: null as { id: string; src: string; seq: number } | null,
  note: null as string | null,
  fps: '',
  opening: false,
  focusTakeOver: false,
};

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
/** Redraws on any change to the view or the recording. */
export const useLive = () => { useSyncExternalStore(subscribe, () => version); return live; };

export const recorder = createRecorder({ api, toast: (m) => toast.error(m), changed: emit });

export const setNote = (note: string | null) => { live.note = note; emit(); };
export const setOpening = (on: boolean) => { live.opening = on; emit(); };
export const loading = () => live.opening || !!live.view?.since;

// ponytail: the stream protocol has no load event (frame, status, tabs, url, console only), so a navigation (url message)
// counts as loading until frames stop changing for 1 s, 15 s max. Upgrade: the gateway runs `wait --load load` and sends a message.
function settle(v: View, nav = false) {
  if (nav) v.since = Date.now();
  else if (!v.since || Date.now() - v.since > 15_000) return;
  clearTimeout(v.settle);
  v.settle = setTimeout(() => { v.since = 0; emit(); }, 1000);
}

export function openView(id: string, control: boolean) {
  if (live.view?.id === id) { live.view.control = control; live.note = null; return emit(); }
  closeView();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${profilePath(id)}/stream?pacing=ack&maxFps=20`);
  const v: View = { id, ws, control, meta: null, frames: 0 };
  Object.assign(live, { view: v, frame: null, note: null });
  ws.onclose = () => {
    if (live.view !== v) return;
    clearTimeout(v.settle);
    Object.assign(live, { view: null, note: 'View closed', fps: '', ...(!v.seen && { frame: null }) });
    emit();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'frame') {
      v.meta = msg.metadata; v.frames++; settle(v);
      live.frame = { id, src: 'data:image/jpeg;base64,' + msg.data, seq: msg.seq };
      emit();
    } else if (msg.type === 'url') {
      v.url = msg.url; settle(v, true); emit();
    }
  };
  emit();
}

/** The image of frame seq is drawn: ask for the next one. */
export function drawn(seq: number) {
  const v = live.view;
  if (!v) return;
  if (!v.seen) { v.seen = true; emit(); }
  if (v.ws.readyState === 1) v.ws.send(JSON.stringify({ type: 'ack', seq }));
}

export function closeView() {
  const v = live.view;
  recorder.stop();
  if (v) { live.view = null; clearTimeout(v.settle); v.ws.close(); if (!v.seen) live.frame = null; }
  Object.assign(live, { note: null, fps: '' });
  emit();
}

/** Input to the browser, only with control. */
export const send = (m: object) => { const v = live.view; if (v?.control && v.ws.readyState === 1) v.ws.send(JSON.stringify(m)); };

setInterval(() => { const v = live.view; if (v) { live.fps = `${v.frames} fps`; v.frames = 0; emit(); } }, 1000);

const find = (qc: QueryClient, id: string) => qc.getQueryData(computersQuery.queryKey)?.find((c) => c.id === id);
const refreshList = (qc: QueryClient) => qc.refetchQueries({ queryKey: computersQuery.queryKey });

/** Starts the browser if needed, then opens the view. */
export async function takeControl(qc: QueryClient, id: string, control = true) {
  setNote('Starting…');
  try { await api(`${profilePath(id)}/start`, 'POST'); } catch (e) { setNote(message(e)); throw e; }
  await refreshList(qc);
  openView(id, control);
}

/** Take over: takes the agent's open request first, if any. */
export async function takeOver(qc: QueryClient, id: string) {
  if (find(qc, id)?.handoff) await api(`${profilePath(id)}/handoff-take`, 'POST');
  if (find(qc, id)?.role === 'viewer') {
    await refreshList(qc);
    if (find(qc, id)?.handoff?.state === 'taken') openView(id, true);
  } else await takeControl(qc, id);
}

/** Record: takes over, then each gesture in the view runs as a step. */
export async function startRecording(qc: QueryClient, id: string) {
  await takeOver(qc, id);
  recorder.start(id);
}
