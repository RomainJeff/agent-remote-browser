// Playbook body <-> form model, no DOM (test/unit/playbook-editor.test.ts runs it against the server parse).
// Same split as the server: first non-empty line = description (store.describe), first ```json block = recipe (steps.recipe).

export const ACTIONS = {
  open: 'Go to a URL (allowed domains only)', login: 'Fill a saved login', click: 'Click an element', fill: 'Type into a field',
  press: 'Press a key', wait: 'Wait for the page', get_text: 'Read the page text', snapshot: 'List the interactive elements, with refs', back: 'Previous page',
};
export type Action = keyof typeof ACTIONS;
export const LOCATORS = ['text', 'label', 'role', 'placeholder', 'testid', 'css', 'ref'];
export const WAITS = ['load', 'text', 'url', 'selector', 'ms'];

/** One form row: kind = locator or wait kind, v = its main value. */
export type Fields = { kind?: string; v?: string; name?: string; value?: string; keep?: boolean; if_needed?: boolean };
/** A step the form can't show round-trip (exact, get_text by selector...) stays a JSON row. */
export type Row = { a: Action; f: Fields } | { raw: string };
export type Model = { desc: string; notes: string; steps: Row[]; fallback: string };
type Step = Record<string, any>;

export const DEFAULTS: Record<Action, Fields> = {
  open: { v: 'https://' }, login: { v: '', if_needed: true }, click: { kind: 'text', v: '' }, fill: { kind: 'label', v: '', value: '' },
  press: { v: 'Enter' }, back: {}, wait: { kind: 'load', v: 'networkidle' }, get_text: { v: '', keep: true }, snapshot: { v: '', keep: true },
};

function from(s: Step): { a: Action; f: Fields } {
  const a = (Object.keys(ACTIONS) as Action[]).find((k) => k in s)!, x = s[a];
  if (a === 'click' || a === 'fill') { const kind = LOCATORS.find((k) => k in x)!; return { a, f: { kind, v: x[kind], name: x.name, value: s.value } }; }
  if (a === 'wait') { const kind = WAITS.find((k) => k in x)!; return { a, f: { kind, v: x[kind] } }; }
  if (a === 'get_text') return { a, f: { v: x.contains, keep: s.keep } };
  if (a === 'snapshot') return { a, f: { v: x.scope, keep: s.keep } };
  if (a === 'login') return { a, f: { v: x, if_needed: s.if_needed } };
  return { a, f: { v: x } };
}

export function toStep({ a, f }: { a: Action; f: Fields }): Step {
  const loc = () => ({ [f.kind!]: f.v ?? '', ...(f.kind === 'role' && f.name && { name: f.name }) }), keep = f.keep ? { keep: true } : {};
  return {
    open: () => ({ open: f.v }), login: () => ({ login: f.v, ...(f.if_needed && { if_needed: true }) }), click: () => ({ click: loc() }),
    fill: () => ({ fill: loc(), value: f.value ?? '' }), press: () => ({ press: f.v }), back: () => ({ back: true }),
    wait: () => ({ wait: { [f.kind!]: f.kind === 'ms' ? Number(f.v) : f.v } }),
    get_text: () => ({ get_text: f.v ? { contains: f.v } : {}, ...keep }), snapshot: () => ({ snapshot: f.v ? { scope: f.v } : {}, ...keep }),
  }[a]();
}

const row = (s: Step): Row => { try { const r = from(s); if (JSON.stringify(toStep(r)) === JSON.stringify(s)) return r; } catch {} return { raw: JSON.stringify(s) }; };
const fmt = (v: unknown): string => v && typeof v === 'object'
  ? (Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : `{${Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + fmt(x)).join(', ')}}`)
  : JSON.stringify(v);

const RECIPE = /```json[^\n]*\n([\s\S]*?)\n```/;

/** The model, or {err} when the recipe can't be read. */
export function parse(body: string): Model | { err: string } {
  const lines = body.split('\n'), i = lines.findIndex((l) => l.trim());
  const desc = i < 0 ? '' : lines[i].replace(/^\s*#+\s*/, '').trim(), rest = i < 0 ? '' : lines.slice(i + 1).join('\n');
  const m = rest.match(RECIPE);
  if (!m) return { desc, notes: rest.trim(), steps: [], fallback: '' };
  let j; try { j = JSON.parse(m[1]); } catch (e) { return { err: 'invalid JSON in the recipe (' + (e as Error).message + ').' }; }
  const s = Array.isArray(j) ? j : j?.steps;
  if (!Array.isArray(s) || s.some((x) => !x || typeof x !== 'object')) return { err: 'the recipe needs {"steps": [...]}, one object per step.' };
  return { desc, notes: rest.slice(0, m.index).trim(), steps: s.map(row), fallback: rest.slice(m.index! + m[0].length).trim() };
}

// ponytail: the form rewrites the json block one step per line; hand formatting inside it is lost, the text around is kept.
export function serialize(m: Model) {
  const out = [m.desc || m.notes || m.steps.length || m.fallback ? '# ' + m.desc : ''];
  if (m.notes) out.push(m.notes);
  if (m.steps.length) out.push('```json\n{"steps": [\n' + m.steps.map((r) => '  ' + ('raw' in r ? r.raw : fmt(toStep(r)))).join(',\n') + '\n]}\n```');
  if (m.fallback) out.push(m.fallback);
  return out.join('\n\n');
}

/** The {placeholders} of the recipe: what the agent fills in. */
export const placeholders = (body: string) => [...new Set([...(body.match(RECIPE)?.[1] ?? '').matchAll(/\{([A-Za-z_]\w*)\}/g)].map((x) => x[1]))];
export const toolName = (name: string) => 'pb_' + name.replaceAll('-', '_');

/** A piece of a step sentence: plain text, code (URL, selector, key), an element on the page, a typed value, or an
 *  input the agent fills ({name}). */
export type Part = string | { code: string } | { el: string } | { val: string } | { input: string };
export const partText = (parts: Part[]) => parts.map((p) => typeof p === 'string' ? p : Object.values(p)[0]).join('');

const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
const value = (v: unknown): Part => { const s = String(v ?? ''), m = s.match(/^\{([A-Za-z_]\w*)\}$/); return m ? { input: m[1] } : { val: s }; };
const target = (l: any): Part => {
  if (!l || typeof l !== 'object') return { code: JSON.stringify(l) };
  if ('role' in l) return l.name ? { el: l.name } : { code: l.role };
  const k = LOCATORS.find((k) => k in l);
  return !k ? { code: JSON.stringify(l) } : ['css', 'ref', 'testid'].includes(k) ? { code: l[k] } : { el: String(l[k]) };
};

/** One step as a sentence, for the recorder and the playbook detail. A shape it does not know comes back as its JSON. */
export function describeStep(s: Step): Part[] {
  const a = (Object.keys(ACTIONS) as Action[]).find((k) => k in s), x = a && s[a];
  switch (a) {
    case 'open': return ['Open ', { code: shortUrl(String(x)) }];
    case 'login': return ['Sign in with the saved login ', { code: String(x) }, ...(s.if_needed ? [', if asked'] : [])];
    case 'click': return ['Click ', target(x)];
    case 'fill': return ['Type ', value(s.value), ' in ', target(x)];
    case 'press': return ['Press ', String(x)];
    case 'back': return ['Go back'];
    case 'wait': {
      const k = WAITS.find((k) => k in (x ?? {}));
      if (k === 'load') return ['Wait for the page to load'];
      if (k === 'ms') return [`Wait ${x.ms} ms`];
      if (k === 'text') return ['Wait for ', { el: String(x.text) }];
      if (k) return ['Wait for ', { code: String(x[k]) }];
      break;
    }
    case 'get_text': {
      const where = x?.selector ?? x?.ref;
      return ['Read the text of ', where ? { code: where } : 'the page', ...(x?.contains ? [' around ', value(x.contains)] : [])];
    }
    case 'snapshot': return ['List the elements', ...(x?.scope ? [' in ', { code: x.scope } as Part] : [])];
  }
  return [{ code: JSON.stringify(s) }];
}
