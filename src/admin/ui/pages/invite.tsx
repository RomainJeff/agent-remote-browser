import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { AuthLayout, FormError } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Step = { n: 0 } | { n: 1; totpURI: string; qrSVG: string } | { n: 2; backupCodes: string[] };

/** One-time invitation: choose a password, enroll an authenticator, keep the backup codes. */
export function InvitePage({ token }: { token: string }) {
  const [step, setStep] = useState<Step>({ n: 0 });
  return (
    <AuthLayout>
      <Card className="w-full max-w-[420px] gap-5 p-8">
        <Progress current={step.n} />
        {step.n === 0 && (
          <StepForm key={0} title="Accept invitation" onSubmit={async (data) => {
            const r = await api<{ totpURI: string; qrSVG: string }>('/api/invite/start', 'POST', { token, password: data.get('password') });
            setStep({ n: 1, ...r });
          }}>
            <Field><FieldLabel htmlFor="password">New password</FieldLabel><Input id="password" name="password" type="password" autoComplete="new-password" required autoFocus /></Field>
          </StepForm>
        )}
        {step.n === 1 && (
          <StepForm key={1} title="Set up your authenticator" onSubmit={async (data) => {
            const r = await api<{ backupCodes: string[] }>('/api/invite/finish', 'POST', { token, code: String(data.get('code')).trim() });
            setStep({ n: 2, ...r });
          }}>
            <Field>
              <FieldLabel>Scan with your authenticator app</FieldLabel>
              <img className="size-44 self-center [image-rendering:pixelated]" alt="QR code" src={`data:image/svg+xml,${encodeURIComponent(step.qrSVG)}`} />
            </Field>
            <details className="text-sm">
              <summary className="cursor-pointer text-primary">Can't scan? Copy the link</summary>
              <textarea className="mt-2 w-full rounded-lg border border-input p-2 font-mono text-[13px]" aria-label="Authenticator link" readOnly value={step.totpURI} />
            </details>
            <Field><FieldLabel htmlFor="code">6-digit code shown in the app</FieldLabel><Input id="code" name="code" className="h-12 text-center font-mono text-[22px]! font-semibold tracking-[.3em]" inputMode="numeric" autoComplete="one-time-code" required autoFocus /></Field>
          </StepForm>
        )}
        {step.n === 2 && (
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-extrabold">Save your backup codes</h1>
            <pre className="rounded-lg bg-foreground p-3 font-mono text-[13px] text-muted">{step.backupCodes.join('\n')}</pre>
            <Link to="/login" className="font-semibold text-primary">Sign in</Link>
          </div>
        )}
      </Card>
    </AuthLayout>
  );
}

export function StepForm({ title, children, onSubmit }: { title: string; children: ReactNode; onSubmit: (data: FormData) => Promise<void> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try { await onSubmit(new FormData(e.currentTarget)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <h1 className="text-2xl font-extrabold">{title}</h1>
      {children}
      <Button type="submit" size="lg" disabled={busy}>Continue</Button>
      <FormError>{error}</FormError>
    </form>
  );
}

function Progress({ current }: { current: number }) {
  return (
    <ol className="flex">
      {['Password', 'Authenticator', 'Backup codes'].map((label, i) => (
        <li key={label} aria-current={i === current ? 'step' : undefined}
          className={cn('relative flex flex-1 flex-col items-center gap-1.5 text-center text-xs font-semibold text-muted-foreground',
            i > 0 && 'before:absolute before:top-[11px] before:right-[calc(50%+18px)] before:left-[calc(-50%+18px)] before:h-0.5 before:bg-border',
            i > 0 && i <= current && 'before:bg-primary', i === current && 'font-extrabold text-foreground')}>
          <b className={cn('flex size-6 items-center justify-center rounded-full border-2 border-border bg-card font-bold',
            i < current && 'border-primary bg-primary text-primary-foreground',
            i === current && 'border-primary text-primary shadow-[0_0_0_4px_var(--secondary)]')}>
            {i < current ? <CheckIcon className="size-3.5" strokeWidth={3} /> : i + 1}
          </b>
          {label}
        </li>
      ))}
    </ol>
  );
}
