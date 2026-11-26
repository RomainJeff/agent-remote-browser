import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AuthLayout, AuthTitle, FormError } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { sessionQuery } from '@/lib/session';

const status = (e: unknown) => e instanceof ApiError ? e.status : 0;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Sign-in: password, then the TOTP or a backup code (Better Auth session cookie). */
export function LoginPage() {
  const queryClient = useQueryClient(), navigate = useNavigate();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = (fn: (data: FormData) => Promise<void>) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try { await fn(new FormData(e.currentTarget)); } finally { setBusy(false); }
  };

  const enter = async () => {
    const session = await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    if (session) await navigate({ to: '/profiles' });
    return !!session;
  };

  const signIn = submit(async (data) => {
    try {
      const r = await api<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', 'POST', { email: String(data.get('email')).trim(), password: data.get('password') });
      // No twoFactorRedirect: a trusted device (signed in) or TOTP not enrolled (the server refuses that session).
      if (!r.twoFactorRedirect) {
        if (await enter()) return;
        throw new Error('2FA is not set up: run `arb admin reset-2fa`.');
      }
      setError(''); setBackup(false); setStep('code');
    } catch (e) {
      setError(status(e) === 429 ? 'Too many attempts. Wait a minute and try again.' : status(e) === 401 ? 'Wrong email or password.' : message(e));
    }
  });

  const verify = submit(async (data) => {
    try {
      await api(`/api/auth/two-factor/${backup ? 'verify-backup-code' : 'verify-totp'}`, 'POST', { code: String(data.get('code')).trim(), trustDevice: data.has('trust') });
      await enter();
    } catch (e) {
      setError(status(e) === 429 ? 'Too many attempts. The account locks for 15 min after 5 failures.' : status(e) === 401 ? 'Invalid or expired code. Sign in again if this keeps happening.' : message(e));
    }
  });

  return (
    <AuthLayout foot={<p className="max-w-[420px] text-center text-[13px] leading-5 text-ink-3">Lost your phone and your backup codes? Two-step sign-in is reset on the server, with <code className="font-mono text-xs text-ink">admin reset-2fa</code>.</p>}>
      {step === 'password' ? (
        <form className="flex flex-col gap-[18px]" onSubmit={signIn}>
          <div className="flex flex-col gap-1"><span className="text-[13px] text-ink-3">Step 1 of 2</span><AuthTitle title="Sign in" /></div>
          <Field><FieldLabel htmlFor="email">Email</FieldLabel><Input id="email" name="email" type="email" className="h-[38px]" autoComplete="username" required autoFocus /></Field>
          <Field><FieldLabel htmlFor="password">Password</FieldLabel><Input id="password" name="password" type="password" className="h-[38px]" autoComplete="current-password" required /></Field>
          <FormError>{error}</FormError>
          <Button type="submit" className="h-[38px]" disabled={busy}>Continue</Button>
        </form>
      ) : (
        <form className="flex flex-col gap-[18px]" onSubmit={verify}>
          <div className="flex flex-col gap-1"><span className="text-[13px] text-ink-3">Step 2 of 2</span>
            <AuthTitle title="Enter your code" lead={backup ? 'One of the backup codes you saved. Each works once.' : 'From the authenticator app on your phone.'} /></div>
          {backup ? (
            <Field key="backup">
              <FieldLabel htmlFor="code">Backup code</FieldLabel>
              <Input id="code" name="code" className="h-[38px] font-mono" maxLength={32} autoComplete="off" required autoFocus />
            </Field>
          ) : (
            <Field key="totp">
              <FieldLabel htmlFor="code">6-digit code</FieldLabel>
              <Input id="code" name="code" className="h-[50px] text-center font-mono text-2xl! font-medium tracking-[.28em]" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
            </Field>
          )}
          <Field orientation="horizontal">
            <Checkbox id="trust" name="trust" />
            <FieldLabel htmlFor="trust" className="flex-col items-start gap-0 font-normal">Trust this device for 30 days<FieldDescription>Sensitive actions still ask for a code.</FieldDescription></FieldLabel>
          </Field>
          <FormError>{error}</FormError>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-[38px]" onClick={() => { setError(''); setStep('password'); }}>Back</Button>
            <Button type="submit" className="h-[38px] flex-1" disabled={busy}>Verify</Button>
          </div>
          <Button type="button" variant="link" className="-mt-1.5 self-center px-1 text-[13px] text-ink-2 underline underline-offset-[3px]" onClick={() => { setError(''); setBackup(!backup); }}>{backup ? 'Use the authenticator code' : 'Use a backup code'}</Button>
        </form>
      )}
    </AuthLayout>
  );
}
