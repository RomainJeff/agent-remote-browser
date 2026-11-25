// Record (teach mode): the gateway runs each gesture of the live view as a run_steps step; the draft stays in this page.
// No DOM: test/unit/record.test.ts runs it with the API stubbed.
//
// Gestures run one at a time (q), each bound to the recording it started in (g): a stop, or a new recording,
// mid-gesture drops the rest of it.
// Typing is buffered here and sent as one fill on the next click or key: the page shows it only then.
// lost: the last gesture (other than a read) failed, a replay that stopped partway included, so the focus may be on
// another field; typing is off until a click goes through (the gateway refuses it too), else a password could be filled there.
// seq: the last gesture that may move the focus; typing names it (after) and this recording (rid, every call), so the
// gateway refuses text that follows a gesture it did not run, or one of another tab's recording.
// pick: the saved logins of the site to pick from, for a password field; Save and Replay wait for it.
// The first character typed into an empty buffer queues teach-focus: the gateway notes the field focused then and fills
// only that field on the flush, so text typed after a Tab is dropped if the page moved the focus in between.
// ponytail: no idle flush; add a timer if typing never followed by a click or a key turns out to matter.

type Step = Record<string, any>;
/** field: a click that focused a text field. typed: what was typed, for a fill. param/pname: the fill becomes {pname}. */
export type RecStep = { step: Step; field?: boolean; typed?: string; param?: boolean; pname?: string; text?: string };
export type Pick = { site: string; username: string }[];
export type Rec = { id: string; rid: string; steps: RecStep[]; buf: string; q: Promise<unknown>; lost: boolean; seq?: number; pick?: Pick | null; out: string };
type Reply = RecStep & { pick?: Pick; ok?: boolean; text?: string };
export type Api = (path: string, method: 'POST', body: unknown) => Promise<unknown>;
export type Key = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

const STALE = Symbol('stale');
const REC_KEYS = ['Enter', 'Tab', 'Escape'];
const same = (a: unknown, b: unknown) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
const slug = (l: Step) => {
  const s = String(l.name || l.placeholder || l.label || l.text || 'value').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return /^[a-z_]/.test(s) ? s : 'p_' + s;
};

/** Save and Replay: on once there is a step or typing (they send it first), off while a login is to pick. */
export const canSave = (g: Rec) => !g.pick && (g.steps.length > 0 || !!g.buf);

/** The draft as a playbook body; ticked fills become {params}, their typed values the replay params. */
export function recBody(g: Rec) {
  const params: Record<string, string | undefined> = {};
  const steps = g.steps.map(({ step, param, pname = '', typed }) => {
    if (!param || !step.fill) return step;
    if (!/^[A-Za-z_]\w{0,39}$/.test(pname) || pname === '__proto__') throw new Error(`Input name "${pname}": letters, digits and _, not starting with a digit`);
    if (Object.hasOwn(params, pname) && params[pname] !== typed) throw new Error(`Input "${pname}" is used for different values: rename one`);
    params[pname] = typed;
    return { ...step, value: `{${pname}}` };
  });
  const names = Object.keys(params);
  return { params, body: `# Describe this playbook: the agent sees this line\n\n${names.length ? `Params: ${names.map((k) => `{${k}}`).join(', ')}.\n\n` : ''}\`\`\`json\n${JSON.stringify({ steps }, null, 2)}\n\`\`\`\n` };
}

/** changed: the draft or its state moved (redraw). toast: a gesture failed. */
export function createRecorder({ api, toast, changed }: { api: Api; toast: (msg: string) => void; changed: () => void }) {
  let rec: Rec | null = null, SEQ = 0;

  async function tcall(g: Rec, a: string, body: Step): Promise<Reply> {
    if (rec !== g) throw STALE;
    body = { ...body, rec: g.rid, ...(a === 'type' || a === 'focus' ? { after: g.seq } : a === 'read' ? {} : { seq: g.seq = ++SEQ }) };
    const fail = () => { if (a !== 'read') { g.lost = true; g.buf = ''; changed(); } };
    let r: Reply;
    try { r = await api(`/api/computers/${encodeURIComponent(g.id)}/teach-${a}`, 'POST', body) as Reply; }
    catch (e) { fail(); throw e; }
    // A replay that stopped partway left the focus wherever it stopped.
    if (a === 'replay' && !r.ok) fail();
    if (a === 'click' || a === 'open') { g.lost = false; changed(); }
    if (rec !== g) throw STALE;
    return r;
  }

  function gesture(fn: (g: Rec) => Promise<unknown>) {
    const g = rec!;
    g.q = g.q.then(() => rec === g && fn(g)).catch((e) => { if (rec === g && e !== STALE) toast(e instanceof Error ? e.message : String(e)); });
  }

  function addStep(g: Rec, r: RecStep) {
    if (rec !== g) return;
    const s = g.steps, last = s.at(-1);
    // One step per intent: a fill replaces the click that focused its field, or an earlier fill of the same field;
    // a login replaces the field clicks (and Tabs) that led to it, nothing else (a username fill before it stays: harmless,
    // and a field that only looks like it may be a required one).
    if (r.step.fill && last && ((last.field && same(last.step.click, r.step.fill)) || same(last.step.fill, r.step.fill))) s.pop();
    if (r.step.login) while (s.at(-1)?.field || s.at(-1)?.step.press === 'Tab') s.pop();
    if (r.step.fill) { const b = slug(r.step.fill); let n = b, i = 2; while (s.some((x) => x.pname === n)) n = `${b}_${i++}`; r.pname = n; }
    s.push(r);
    changed();
  }

  /** Takes the typing buffer now (it belongs to the field focused before this gesture), sends it, then fn(g, fill or login step).
   *  draft (Save, Replay): a login still to pick stops it, else the draft would miss the login; a gesture in the view drops the pick. */
  function withBuf(fn: (g: Rec, r: Reply | null) => Promise<unknown>, draft = false) {
    const g = rec;
    if (!g) return;
    const text = g.buf;
    g.buf = '';
    if (!draft) g.pick = null;
    changed();
    gesture(async () => {
      // A pick that came back while this view gesture waited (its type was queued before): this gesture drops it too.
      if (!draft && g.pick) { g.pick = null; changed(); }
      let r: Reply | null = null;
      if (text) {
        // A gesture queued before this one failed: the focus is not where this text was typed.
        if (g.lost) throw new Error('Typing dropped: the click before it did not go through. Click the field again');
        r = await tcall(g, 'type', { text });
        // Several saved logins for this password field: the admin picks one, the rest of this gesture is dropped.
        if (r.pick) { g.pick = r.pick; return changed(); }
        if (r.step.fill) r.typed = text;
        addStep(g, r);
      }
      if (draft && g.pick) throw new Error('Pick the saved login to use first, or Cancel');
      await fn(g, r);
    });
  }

  function addBuf(t: string) {
    const g = rec;
    if (!g) return;
    if (!g.lost && t) { if (!g.buf) gesture(() => tcall(g, 'focus', {})); g.buf = (g.buf + t).slice(0, 500); }
    changed();
  }

  return {
    get rec() { return rec; },
    start(id: string) { rec = { id, rid: crypto.getRandomValues(new Uint32Array(4)).join('-'), steps: [], buf: '', q: Promise.resolve(), lost: false, out: '' }; changed(); },
    stop() { if (rec) { rec = null; changed(); } },
    tcall, addStep, withBuf, addBuf,
    click: (p: { x: number; y: number }) => withBuf(async (g) => addStep(g, await tcall(g, 'click', p))),
    open: (url: string) => withBuf(async (g) => addStep(g, await tcall(g, 'open', { url }))),
    read: (q: { selector?: string; contains?: string }) => withBuf(async (g) => { const r = await tcall(g, 'read', q); addStep(g, r); g.out = r.text ?? ''; changed(); }),
    replay: () => withBuf(async (g) => {
      g.out = 'Replaying…'; changed();
      const r = await tcall(g, 'replay', recBody(g));
      g.out = `${r.ok ? 'OK' : 'Failed'}\n${r.text}`; changed();
    }, true),
    /** A key in the view while recording: Enter, Tab and Escape flush the typing and run; other keys type. */
    key(e: Key) {
      const g = rec;
      if (!g || ((e.ctrlKey || e.metaKey) && !e.altKey)) return; // shortcuts are not recorded
      // A login step submits the form itself: no Enter after it.
      if (REC_KEYS.includes(e.key)) return withBuf(async (g, r) => { if (!r?.step.login) addStep(g, await tcall(g, 'press', { key: e.key })); });
      if (g.lost) return changed();
      if (e.key === 'Backspace') g.buf = g.buf.slice(0, -1);
      else if ([...e.key].length === 1) return addBuf(e.key);
      else return;
      changed();
    },
    pick(site: string) {
      const g = rec;
      if (!g) return;
      g.pick = null;
      changed();
      gesture(async () => addStep(g, await tcall(g, 'type', { login: site })));
    },
    cancelPick() { if (rec) { rec.pick = null; changed(); } },
    /** A step's param or name was edited in place. */
    edited: changed,
  };
}
export type Recorder = ReturnType<typeof createRecorder>;
