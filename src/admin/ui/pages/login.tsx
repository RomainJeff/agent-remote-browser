import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Brand } from '@/components/brand';
import { AuthLayout, FormError } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
    <AuthLayout>
      <Brand />
      <Card className="w-full max-w-[420px] gap-5 p-8">
        {step === 'password' ? (
          <form className="flex flex-col gap-4" onSubmit={signIn}>
            <div><StepLabel>Step 1 of 2</StepLabel><h1 className="text-2xl font-extrabold">Sign in</h1></div>
            <Field><FieldLabel htmlFor="email">Email</FieldLabel><Input id="email" name="email" type="email" autoComplete="username" required autoFocus /></Field>
            <Field><FieldLabel htmlFor="password">Password</FieldLabel><Input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
            <Button type="submit" size="lg" disabled={busy}>Continue</Button>
          </form>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={verify}>
            <div><StepLabel>Step 2 of 2</StepLabel><h1 className="text-2xl font-extrabold">Authenticator code</h1></div>
            <p className="text-muted-foreground">Open your authenticator app and enter the 6-digit code.</p>
            {backup ? (
              <Field key="backup">
                <FieldLabel htmlFor="code">Backup code</FieldLabel>
                <Input id="code" name="code" className="font-mono" maxLength={32} autoComplete="off" required autoFocus />
                <FieldDescription>Each code works only once.</FieldDescription>
              </Field>
            ) : (
              <Field key="totp">
                <FieldLabel htmlFor="code">6-digit code</FieldLabel>
                <Input id="code" name="code" className="h-12 text-center font-mono text-[22px]! font-semibold tracking-[.3em]" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
              </Field>
            )}
            <Button type="button" variant="link" className="self-start px-0" onClick={() => setBackup(!backup)}>{backup ? 'Use the authenticator code' : 'Use a backup code'}</Button>
            <Field orientation="horizontal">
              <Checkbox id="trust" name="trust" />
              <FieldLabel htmlFor="trust" className="flex-col items-start gap-0 font-normal">Trust this device for 30 days<FieldDescription>Admin port only. Sensitive actions still ask for a code.</FieldDescription></FieldLabel>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="lg" onClick={() => { setError(''); setStep('password'); }}>Back</Button>
              <Button type="submit" size="lg" disabled={busy}>Verify</Button>
            </div>
          </form>
        )}
        <FormError>{error}</FormError>
      </Card>
      <p className="max-w-[420px] text-center text-xs text-muted-foreground">Lost your 2FA and have no backup code? On the host machine, run <code className="font-mono">node src/cli.ts admin reset-2fa</code>.</p>
    </AuthLayout>
  );
}

const StepLabel = ({ children }: { children: string }) => <div className="text-xs font-bold tracking-wider text-primary uppercase">{children}</div>;
