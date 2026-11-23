// run_steps: a known path in one call. The step schema and the pure step -> agent-browser argv mapping; the loop is in tools.ts.
// get_text and snapshot params are shared with the tools of the same name.
import { z } from 'zod';

/** One run_steps call, all steps included. ponytail: mutable so tests can shorten it; not a setting. */
export const limits = { budgetMs: 18_000 };
/** Error text when the budget runs out. */
export const BUDGET = 'budget';

export const REF = z.string().regex(/^@?e\d+$/, 'use a ref from snapshot, e.g. @e3').describe('Element ref from snapshot, e.g. @e3');
export const at = (r: string) => (r.startsWith('@') ? r : '@' + r);
const noDash = (s: string) => !s.startsWith('-');
export const SEL = z.string().min(1).max(500).refine(noDash, 'a selector cannot start with "-"');
const VAL = z.string().min(1).max(500).refine(noDash, 'cannot start with "-"');
const MAX = (d: number) => z.number().int().min(1).max(50_000).default(d).describe('Characters returned at most');

export const GET_TEXT = {
  ref: REF.optional(),
  selector: SEL.optional().describe('CSS selector, instead of ref'),
  contains: z.string().min(1).max(200).optional().describe('Only lines containing this (case-insensitive), with context lines around'),
  context: z.number().int().min(0).max(10).default(2).describe('Lines kept before and after each match'),
  max_chars: MAX(4000),
};
export const SNAPSHOT = {
  // agent-browser 0.43 `snapshot -s` runs querySelector: a ref is an invalid selector there.
  scope: SEL.refine((s) => !/^@?e\d+$/.test(s), 'scope takes a CSS selector, not a ref').optional()
    .describe('Only the subtree matching this CSS selector, e.g. main or #usage'),
  compact: z.boolean().default(true).describe('Drop empty structural elements'),
  max_chars: MAX(8000),
};
type GetText = z.output<z.ZodObject<typeof GET_TEXT>>;
type Snapshot = z.output<z.ZodObject<typeof SNAPSHOT>>;

/** At most `max` characters of `text`; says so when it cut, so the client can narrow its query. */
export const clip = (text: string, max: number): { text: string; truncated?: true; total_chars?: number } =>
  text.length > max ? { text: text.slice(0, max), truncated: true, total_chars: text.length } : { text };

/** Lines containing `needle` (case-insensitive) with `context` lines around each. Windows that overlap or touch merge;
 *  blocks are separated by a "…" line. No match: `matches: 0` and empty text. */
export function grep(text: string, needle: string, context: number) {
  const lines = text.split('\n'), n = needle.toLowerCase(), blocks: [number, number][] = [];
  let matches = 0;
  lines.forEach((l, i) => {
    if (!l.toLowerCase().includes(n)) return;
    matches++;
    const a = Math.max(0, i - context), b = Math.min(lines.length - 1, i + context), last = blocks.at(-1);
    if (last && a <= last[1] + 1) last[1] = b; else blocks.push([a, b]);
  });
  return { matches, text: blocks.map(([a, b]) => lines.slice(a, b + 1).join('\n')).join('\n…\n') };
}

/** agent-browser data of get_text / snapshot -> page text and the gateway's signals (matches, truncated). */
export function readOut(s: { get_text: GetText } | { snapshot: Snapshot }, d: Record<string, any>) {
  if ('snapshot' in s) {
    const { text, ...meta } = clip(d.snapshot || '(no interactive elements)', s.snapshot.max_chars);
    return { origin: d.origin, text, meta };
  }
  const { contains, context, max_chars } = s.get_text, all = String(d.text ?? '');
  const m = contains === undefined ? null : grep(all, contains, context);
  const { text, ...meta } = clip(m ? m.text : all, max_chars);
  return { origin: d.origin, text, meta: { ...(m && { matches: m.matches }), ...meta } };
}

const exact = { exact: z.boolean().optional().describe('Exact, case-sensitive match') };
export const Locator = z.union([
  z.strictObject({ ref: REF.describe('Ref from snapshot: stale after a navigation') }),
  z.strictObject({ text: VAL, ...exact }),
  z.strictObject({ label: VAL, ...exact }),
  z.strictObject({ role: z.string().regex(/^[a-z]{1,30}$/).describe('ARIA role, e.g. button'), name: VAL.optional().describe('Accessible name'), ...exact }),
  z.strictObject({ placeholder: VAL, ...exact }),
  z.strictObject({ testid: VAL }),
  z.strictObject({ css: SEL.describe('First element matching this CSS selector') }),
]).describe('One of ref, text, label, role (+ name), placeholder, testid, css');
type Locator = z.output<typeof Locator>;

/** Never `--fn` (JavaScript in the page). A selector that reads as a number would be a sleep: refused. */
const Wait = z.union([
  z.strictObject({ ms: z.number().int().min(1).max(5000) }),
  z.strictObject({ text: VAL.describe('Case-sensitive substring of the page text') }),
  z.strictObject({ selector: SEL.refine((s) => Number.isNaN(Number(s)), 'not a number: use ms') }),
  z.strictObject({ url: VAL.describe('URL pattern, e.g. **/dashboard') }),
  z.strictObject({ load: z.enum(['load', 'domcontentloaded', 'networkidle']) }),
]);

const keep = { keep: z.boolean().optional().describe('Return this output too (default: only the last output)') };
export const Step = z.union([
  z.strictObject({ open: z.url({ protocol: /^https?$/ }).max(4096) }),
  z.strictObject({ login: z.string().min(1).max(100), if_needed: z.boolean().optional().describe('Skip when the page has no password field') }),
  z.strictObject({ click: Locator }),
  // find ... fill has no "--" separator: a value starting with "-" can only go to a ref.
  z.strictObject({ fill: Locator, value: z.string().max(5000) })
    .refine((s) => 'ref' in s.fill || (s.value !== '' && noDash(s.value)), { message: 'with a locator, value is not empty and does not start with "-"', path: ['value'] }),
  z.strictObject({ press: z.string().min(1).max(30) }),
  z.strictObject({ back: z.literal(true) }),
  z.strictObject({ wait: Wait }),
  z.strictObject({ get_text: z.strictObject(GET_TEXT)
    .refine((a) => a.ref === undefined || a.selector === undefined, { message: 'Pass ref or selector, not both', path: ['selector'] }), ...keep }),
  z.strictObject({ snapshot: z.strictObject(SNAPSHOT), ...keep }),
]);
export type Step = z.output<typeof Step>;
export const Steps = z.array(Step).min(1).max(20);

/** find <kind> <value> <action> [<text>] [--name n] [--exact], or the plain ref command. */
function act(l: Locator, action: string[]): string[] {
  if ('ref' in l) return action[0] === 'click' ? ['click', at(l.ref)] : ['fill', at(l.ref), '--', action[1]];
  if ('css' in l) return ['find', 'first', l.css, ...action];
  if ('testid' in l) return ['find', 'testid', l.testid, ...action];
  if ('role' in l) return ['find', 'role', l.role, ...action, ...(l.name ? ['--name', l.name, ...(l.exact ? ['--exact'] : [])] : [])];
  const [kind, v] = Object.entries(l).find(([k]) => k !== 'exact') as [string, string];
  return ['find', kind, v, ...action, ...(l.exact ? ['--exact'] : [])];
}

/** The agent-browser argv of one step; null for login (fillLogin runs it). */
export function stepArgv(s: Step): string[] | null {
  if ('open' in s) return ['open', s.open];
  if ('click' in s) return act(s.click, ['click']);
  if ('fill' in s) return act(s.fill, ['fill', s.value]);
  if ('press' in s) return ['press', s.press];
  if ('back' in s) return ['back'];
  if ('wait' in s) {
    const w = s.wait;
    return 'ms' in w ? ['wait', String(w.ms)] : 'selector' in w ? ['wait', w.selector]
      : 'text' in w ? ['wait', '--text', w.text] : 'url' in w ? ['wait', '--url', w.url] : ['wait', '--load', w.load];
  }
  if ('get_text' in s) { const a = s.get_text; return ['get', 'text', a.ref ? at(a.ref) : a.selector ?? 'body']; }
  if ('snapshot' in s) { const a = s.snapshot; return ['snapshot', '-i', ...(a.compact ? ['-c'] : []), ...(a.scope ? ['-s', a.scope] : [])]; }
  return null;
}

/** The steps of a playbook's first ```json block ({steps: [...]} or [...]), {placeholders} in its strings filled from params;
 *  an error message otherwise. Filled values go through Steps and the allowlist like any run_steps input. */
export function recipe(body: string, params: Record<string, string>): unknown[] | string {
  const m = body.match(/```json[^\n]*\n([\s\S]*?)\n```/);
  if (!m) return 'This playbook has no run_steps recipe (```json block): read it with playbook';
  let j: any;
  try { j = JSON.parse(m[1]); } catch { return 'The recipe of this playbook is not valid JSON'; }
  const steps = Array.isArray(j) ? j : j?.steps;
  if (!Array.isArray(steps)) return 'The recipe of this playbook has no steps';
  const missing = new Set<string>();
  const fill = (v: unknown): unknown => typeof v === 'string'
    ? v.replace(/\{([A-Za-z_]\w*)\}/g, (all, k) => (Object.hasOwn(params, k) ? params[k] : (missing.add(k), all)))
    : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
  const out = fill(steps) as unknown[];
  return missing.size ? `Missing params: ${[...missing].join(', ')}` : out;
}
