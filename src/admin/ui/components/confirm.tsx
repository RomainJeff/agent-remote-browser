import { useEffect, useState, type FormEvent } from 'react';
import { FormError } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError, setApiHooks } from '@/lib/api';
import { message } from '@/lib/format';
import type { Session } from '@/lib/session';

/** typed: text to retype. code: ask for a 2FA code and open the step-up window before resolving. note: a note for the agent. */
export type AskOptions = { title: string; desc?: string; label?: string; danger?: boolean; typed?: string; code?: boolean; note?: 'optional' | 'required' };
type Pending = AskOptions & { resolve: (r: { note: string } | null) => void };

let show: ((p: Pending) => void) | null = null;

/** In-page confirmation. Resolves true when confirmed (and, with code, once the 2FA code is accepted). */
export const ask = (opts: AskOptions) => new Promise<boolean>((resolve) => show ? show({ ...opts, resolve: (r) => resolve(!!r) }) : resolve(false));
/** The same dialog with a note for the agent: the note ('' when left empty), or null when cancelled. */
export const askNote = (opts: AskOptions & { note: 'optional' | 'required' }) =>
  new Promise<string | null>((resolve) => show ? show({ ...opts, resolve: (r) => resolve(r?.note ?? null) }) : resolve(null));

/** Confirm a sensitive action: asks for the 2FA code in the same dialog only when the step-up window is closed. */
export async function confirmSensitive(opts: AskOptions) {
  const s = await api<Session>('/api/session').catch(() => null);
  return ask({ ...opts, code: !(s && s.stepUpRemainingS > 0) });
}

const codeBody = (c: string) => /^\d{6}$/.test(c) ? { code: c } : { backupCode: c };

/** The one dialog behind ask(), mounted once next to the router. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    show = (p) => { setPending((prev) => { prev?.resolve(null); return p; }); setError(''); };
    setApiHooks({ stepUp: () => ask({ title: 'Confirm with your 2FA code', desc: 'This action is sensitive.', label: 'Confirm', code: true }) });
    return () => { show = null; };
  }, []);
  const finish = (r: { note: string } | null) => { pending?.resolve(r); setPending(null); };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!pending) return;
    const data = new FormData(e.currentTarget), form = e.currentTarget;
    if (pending.typed && String(data.get('typed')).trim() !== pending.typed) return setError('The text does not match.');
    const note = String(data.get('note') ?? '').trim();
    if (pending.note === 'required' && !note) return setError('Tell the agent what went wrong.');
    if (pending.code) {
      const c = String(data.get('code')).trim();
      if (!c) return setError('Enter a code.');
      try { await api('/api/step-up', 'POST', codeBody(c)); }
      catch (err) {
        (form.elements.namedItem('code') as HTMLInputElement).value = '';
        return setError(err instanceof ApiError && err.status === 401 ? 'Invalid code. Five wrong codes end the session.' : message(err));
      }
    }
    finish({ note });
  };

  const p = pending;
  return (
    <Dialog open={!!p} onOpenChange={(open) => { if (!open) finish(null); }}>
      {p && (
        <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[520px]">
          <form noValidate className="flex flex-col gap-4 p-[22px]" onSubmit={submit}>
            <div className="flex flex-col gap-1">
              <DialogTitle className="text-base font-semibold">{p.title}</DialogTitle>
              {p.desc && <DialogDescription>{p.desc}</DialogDescription>}
            </div>
            {p.typed && (
              <Field>
                <FieldLabel htmlFor="typed">Type <span className="font-mono text-foreground">{p.typed}</span> to confirm</FieldLabel>
                <Input id="typed" name="typed" className="font-mono" autoComplete="off" spellCheck={false} autoFocus />
              </Field>
            )}
            {p.code && (
              <Field>
                <FieldLabel htmlFor="stepup">2FA code</FieldLabel>
                <Input id="stepup" name="code" className="font-mono" maxLength={32} autoComplete="one-time-code" placeholder="6 digits, or a backup code" autoFocus={!p.typed} />
                <FieldDescription>After that, sensitive actions won't ask for a code for 15 min.</FieldDescription>
              </Field>
            )}
            {p.note && (
              <Field>
                <FieldLabel htmlFor="note">Note for the agent{p.note === 'optional' && ' (optional)'}</FieldLabel>
                <textarea id="note" name="note" rows={3} maxLength={1000} autoFocus className="rounded-lg border border-input px-3 py-2.5" />
              </Field>
            )}
            <FormError>{error}</FormError>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="lg" onClick={() => finish(null)}>Cancel</Button>
              <Button type="submit" size="lg" variant={p.danger ? 'danger' : 'default'}>{p.label ?? 'Confirm'}</Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
