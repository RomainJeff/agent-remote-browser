import { useEffect, useState, type FormEvent } from 'react';
import { LockIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError, setApiHooks } from '@/lib/api';
import { message } from '@/lib/format';
import type { Session } from '@/lib/session';
import { cn } from '@/lib/utils';

/** typed: text to retype. code: ask for a 2FA code and open the step-up window before resolving. */
export type AskOptions = { title: string; desc?: string; label?: string; danger?: boolean; typed?: string; code?: boolean };
type Pending = AskOptions & { resolve: (ok: boolean) => void };

let show: ((p: Pending) => void) | null = null;

/** In-page confirmation. Resolves true when confirmed (and, with code, once the 2FA code is accepted). */
export const ask = (opts: AskOptions) => new Promise<boolean>((resolve) => show ? show({ ...opts, resolve }) : resolve(false));

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
    show = (p) => { setPending((prev) => { prev?.resolve(false); return p; }); setError(''); };
    setApiHooks({ stepUp: () => ask({ title: 'Confirm with your 2FA code', desc: 'This action is sensitive.', label: 'Confirm', code: true }) });
    return () => { show = null; };
  }, []);
  const finish = (ok: boolean) => { pending?.resolve(ok); setPending(null); };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!pending) return;
    const data = new FormData(e.currentTarget), form = e.currentTarget;
    if (pending.typed && String(data.get('typed')).trim() !== pending.typed) return setError('The text does not match.');
    if (pending.code) {
      const c = String(data.get('code')).trim();
      if (!c) return setError('Enter a code.');
      try { await api('/api/step-up', 'POST', codeBody(c)); }
      catch (err) {
        (form.elements.namedItem('code') as HTMLInputElement).value = '';
        return setError(err instanceof ApiError && err.status === 401 ? 'Invalid code. Five wrong codes end the session.' : message(err));
      }
    }
    finish(true);
  };

  const p = pending;
  return (
    <Dialog open={!!p} onOpenChange={(open) => { if (!open) finish(false); }}>
      {p && (
        <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[520px]">
          <form noValidate className="flex flex-col gap-4 p-6" onSubmit={submit}>
            <span aria-hidden className={cn('flex size-10 items-center justify-center rounded-xl text-lg font-extrabold', p.danger ? 'bg-destructive-soft text-destructive-ink' : 'bg-warn-soft text-warn-ink')}>
              {p.danger ? '!' : <LockIcon className="size-[18px]" />}
            </span>
            <div className="flex flex-col gap-1">
              <DialogTitle className="text-xl font-extrabold">{p.title}</DialogTitle>
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
            <p aria-live="polite" className="min-h-5 text-[13px] font-semibold text-destructive-ink">{error}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="lg" onClick={() => finish(false)}>Cancel</Button>
              <Button type="submit" size="lg" variant={p.danger ? 'danger' : 'default'}>{p.label ?? 'Confirm'}</Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
