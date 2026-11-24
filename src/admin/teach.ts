// Admin teach mode: the admin drives the live view, the gateway turns each gesture into a run_steps step with a
// semantic locator (role + name, label, placeholder, css), runs that step instead of the raw input, and the admin
// saves the list as a playbook through playbook-save. The draft lives in the admin page; nothing is stored here.
import { HIT } from '../runner/protocol.ts';
import { Step, Locator, stepArgv, recipe, readOut, clip } from '../mcp/steps.ts';
import { fillLogin, runSteps } from '../mcp/tools.ts';
import { BrowserError } from '../computers.ts';
import { urlAllowed, type ProfileId } from '../policy.ts';
import type { Profile } from '../store/store.ts';
import type { Ctx } from '../server.ts';

/** One entry of HIT's chain: the element first, then its ancestors. */
export type AX = { role: string; name: string; tag?: string; type?: string; id?: string; attr?: string; placeholder?: string;
  count?: number; exact?: number; ids?: number; names?: number; ph?: number };

/** Landmarks and containers: past these, a locator would match far more than what was clicked. */
const STOP = new Set(['RootWebArea', 'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'list', 'table', 'dialog']);
/** No locator of their own: walk up to the element that has one. */
const SKIP = new Set(['generic', 'none', 'StaticText', 'InlineTextBox', 'LineBreak', 'LabelText', 'paragraph']);
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const usable = (s?: string): s is string => !!s && s.length <= 200 && !s.startsWith('-');

/** The locator of the first element of the chain that has one, among those matching that element only (HIT's counts):
 *  role + name, the same with an exact name, placeholder, css #id, css tag[name=…]. An element whose locators all match
 *  several elements ends the walk with null: agent-browser would act on the first match, maybe not this one. */
export function locate(chain: AX[]): Locator | null {
  for (const e of chain) {
    if (STOP.has(e.role)) return null;
    if (SKIP.has(e.role)) continue;
    const role = e.role === 'image' ? 'img' : e.role, named = usable(e.name) && /^[a-z]{1,30}$/.test(role);
    const all: [Locator | false, number | undefined][] = [
      [named && { role, name: e.name }, e.count],
      [named && { role, name: e.name, exact: true }, e.exact],
      [usable(e.placeholder) && { placeholder: e.placeholder }, e.ph],
      [!!e.id && /^[A-Za-z][\w-]{0,99}$/.test(e.id) && { css: `#${e.id}` }, e.ids],
      [!!e.tag && /^[a-z][a-z0-9]{0,20}$/.test(e.tag) && !!e.attr && /^[\w-]{1,100}$/.test(e.attr) && { css: `${e.tag}[name="${e.attr}"]` }, e.names],
    ];
    const has = all.filter(([l]) => l);
    if (has.length) return has.find(([, n]) => n === 1)?.[0] || null;
  }
  return null;
}

type Reply = [number, Record<string, unknown>];
const NONE: Reply = [422, { error: 'No stable locator matching only this element: try its text or label' }];
const LOST: Reply = [409, { error: 'The last click or typing did not go through, so the focus may be on another field: click the field again' }];
const MOVED: Reply = [409, { error: 'The focus is not on the field you clicked: click the field again' }];
const LEASED: Reply = [409, { error: 'Leased by an agent: take over its request or force release' }];
const KEYS = ['Enter', 'Tab', 'Escape'];

/** teach-* actions. Caller holds pc.serial(id). */
export function teacher(ctx: Pick<Ctx, 'computers' | 'driver' | 'store'>) {
  const { computers: pc, driver, store } = ctx;
  /** Per profile, the last gesture that may move the focus (not type, not read) if it went through: the recording it
   *  belongs to (`rec`, random per Record start in the page), the page's `seq` for it, and the locator of the field it
   *  clicked; {} once any gesture but a read fails. teach-type names its recording and the gesture it follows (`after`):
   *  another recording's gesture (a second admin tab), or one this gateway did not run (failed on the way, refused for
   *  the lease, a replay that stopped partway), means the focus is not where the admin thinks; a focus that left the
   *  clicked field, likewise. */
  const last = new Map<ProfileId, { rec?: unknown; seq?: unknown; target?: string }>();

  async function hit(id: ProfileId, args: string[]) {
    await pc.ensure(id);
    const r = await driver.exec(id, ['node', '-e', HIT, ...args], { timeoutMs: 10_000 });
    if (r.code !== 0) throw new BrowserError((r.stderr || `exit ${r.code}`).trim().slice(0, 300));
    return JSON.parse(r.stdout) as { url: string; chain: AX[]; live?: string };
  }
  /** Runs a step built here; Step checks it first, as run_steps would. */
  async function run(id: ProfileId, step: unknown, extra: object = {}): Promise<Reply> {
    const s = Step.safeParse(step);
    if (!s.success) return [400, { error: `Not a valid step: ${s.error.issues[0].message}` }];
    const d = await pc.ab(id, stepArgv(s.data)!);
    return [200, { step, ...extra, ...('get_text' in s.data && { text: clip(readOut(s.data, d).text, 2000).text }) }];
  }

  async function act(act: string, id: ProfileId, p: Profile, b: Record<string, any>): Promise<Reply> {
    if (act === 'teach-click') {
      if (![b.x, b.y].every((n) => Number.isInteger(n) && n >= 0 && n <= 99_999)) return [400, { error: 'x, y: CSS pixels' }];
      const { chain } = await hit(id, ['at', String(b.x), String(b.y)]), l = locate(chain);
      if (!l) return NONE;
      // field: a click that only focuses a field, dropped by the page when a fill or a login follows.
      return run(id, { click: l }, { field: FIELDS.has(chain.find((e) => !SKIP.has(e.role))?.role ?? '') });
    }
    if (act === 'teach-type') {
      // login: the admin's pick among several saved logins of the origin (no text then).
      const pick = typeof b.login === 'string';
      if (!pick && (typeof b.text !== 'string' || !b.text || b.text.length > 500)) return [400, { error: 'Text: 1 to 500 characters' }];
      const was = last.get(id);
      if (typeof b.rec !== 'string' || !was || b.rec !== was.rec || b.after !== was.seq) return LOST;
      const { url, chain, live } = await hit(id, ['focus']);
      if (live === 'frame') return [422, { error: 'Typing inside a frame is not recorded' }];
      // The live element's type property, or the attribute as written (Chrome reads it case-insensitively).
      if (live === 'password' || chain[0]?.type?.toLowerCase() === 'password') {
        // Never recorded, never sent to the page: the saved login of this origin replaces what was typed.
        const origin = URL.parse(url)?.origin, logins = p.logins || {};
        const sites = Object.keys(logins).filter((s) => URL.parse(logins[s].url)?.origin === origin);
        if (!sites.length) return [422, { error: 'Password field: save a login for this site first (Logins), then type here again' }];
        const site = pick ? sites.find((s) => s === b.login) : sites.length === 1 ? sites[0] : undefined;
        if (pick && !site) return [400, { error: 'No such login for this site' }];
        // Several logins: the page asks which one (names and usernames only), nothing is filled.
        if (!site) return [200, { pick: sites.map((s) => ({ site: s, username: logins[s].username })) }];
        const c = logins[site];
        if (!c.url.startsWith('https://') || !urlAllowed(c.url, p.allow)) return [400, { error: 'Login URL is outside the allowlist' }];
        await fillLogin(pc, id, site, c, store.decryptLogin(id, site, c), true);
        // The login may submit and land on a page that focuses another field: typing goes to the live focus from here.
        was.target = undefined;
        return [200, { step: { login: site, if_needed: true } }];
      }
      if (pick) return MOVED;
      const l = locate(chain);
      if (l && was.target && JSON.stringify(l) !== was.target) return MOVED;
      return l ? run(id, { fill: l, value: b.text }) : NONE;
    }
    if (act === 'teach-press') return KEYS.includes(b.key) ? run(id, { press: b.key }) : [400, { error: `Keys: ${KEYS.join(', ')}` }];
    if (act === 'teach-open') {
      if (typeof b.url !== 'string' || !urlAllowed(b.url, p.allow)) return [400, { error: `Domain not allowed. Allowed: ${p.allow.join(', ')}` }];
      return run(id, { open: b.url });
    }
    if (act === 'teach-read') {
      const a = { ...(b.selector && { selector: b.selector }), ...(b.contains && { contains: b.contains }) };
      return run(id, { get_text: a });
    }
    // teach-replay: the draft as a playbook body, through run_playbook's path.
    if (typeof b.body !== 'string' || b.body.length > 64 * 1024) return [400, { error: 'Body required' }];
    const params = b.params && typeof b.params === 'object' ? Object.fromEntries(Object.entries(b.params).map(([k, v]) => [k, String(v)])) : {};
    const steps = recipe(b.body, params);
    if (typeof steps === 'string') return [400, { error: steps }];
    const r = await runSteps(ctx, steps, id, p);
    return [200, { ok: !r.isError, text: (r.content[0] as { text: string }).text }];
  }

  /** driving: the admin may drive this browser (no agent lease), checked in the profile's queue. */
  return async (a: string, id: ProfileId, p: Profile, b: Record<string, any>, driving: boolean): Promise<Reply> => {
    let r: Reply = [500, {}];
    try { return r = !driving ? LEASED : await act(a, id, p, b); }
    catch (e) { if (e instanceof BrowserError) return r = [422, { error: e.message.slice(0, 300) }]; throw e; }
    finally {
      // LOST refuses before any input (another tab's recording, a gesture not run here): the state stays the active tab's.
      if (r !== LOST && a !== 'teach-read') {
        // A replay that stopped partway (ok: false) failed too: the focus is wherever it stopped.
        const ok = r[0] === 200 && r[1].ok !== false;
        if (!ok) last.set(id, {});
        else if (a !== 'teach-type') last.set(id, { rec: b.rec, seq: b.seq, target: r[1].field ? JSON.stringify((r[1].step as { click: Locator }).click) : undefined });
      }
    }
  };
}
