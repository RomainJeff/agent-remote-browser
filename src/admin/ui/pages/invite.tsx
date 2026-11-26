import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AuthLayout, AuthTitle, FormError } from '@/components/auth-layout';
import { CopyButton } from '@/components/mcp-url';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Step = { n: 0 } | { n: 1; setupKey: string; qrSVG: string } | { n: 2; backupCodes: string[] };

/** One-time invitation: choose a password, enroll an authenticator, keep the backup codes. */
export function InvitePage({ token }: { token: string }) {
  const [step, setStep] = useState<Step>({ n: 0 });
  return (
    <AuthLayout>
      <Progress current={step.n} />
      {step.n === 0 && (
        <StepForm key={0} title="Join the gateway" lead="Choose a password, then set up two-step sign-in." onSubmit={async (data) => {
          const r = await api<{ setupKey: string; qrSVG: string }>('/api/invite/start', 'POST', { token, password: newPassword(data) });
          setStep({ n: 1, ...r });
        }}>
          <NewPasswordFields />
        </StepForm>
      )}
      {step.n === 1 && (
        <StepForm key={1} title="Set up your authenticator" lead="Scan with an authenticator app, then enter the code it shows." onSubmit={async (data) => {
          const r = await api<{ backupCodes: string[] }>('/api/invite/finish', 'POST', { token, code: String(data.get('code')).trim() });
          setStep({ n: 2, ...r });
        }}>
          <img className="size-[172px] self-center rounded-xl border p-2.5 [image-rendering:pixelated]" alt="QR code" src={`data:image/svg+xml,${encodeURIComponent(step.qrSVG)}`} />
          <details className="-mt-1.5 text-[13px]">
            <summary className="mx-auto w-fit cursor-pointer font-medium text-ink-2 underline underline-offset-[3px]">Can't scan? Enter a setup key</summary>
            <div className="mt-2 flex flex-col gap-2">
              <code aria-label="Setup key" className="rounded-lg border bg-surface-2 px-3 py-2 text-center font-mono text-[13.5px] font-medium break-words">{step.setupKey}</code>
              <CopyButton text={step.setupKey.replaceAll(' ', '')} label="Copy key" className="h-[38px]" />
            </div>
          </details>
          <Field>
            <FieldLabel htmlFor="code">6-digit code</FieldLabel>
            <Input id="code" name="code" className="h-[50px] text-center font-mono text-2xl! font-medium tracking-[.28em]" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
          </Field>
        </StepForm>
      )}
      {step.n === 2 && (
        <>
          <AuthTitle title="Save your backup codes" lead="Each one signs you in once if you lose your phone. They won't be shown again." />
          <ol aria-label="Backup codes" className="grid grid-cols-2 gap-x-5 gap-y-2 rounded-xl border bg-surface-2 px-4 py-3.5 font-mono text-[13.5px] font-medium">
            {step.backupCodes.map((c) => <li key={c}>{c}</li>)}
          </ol>
          <CopyButton text={step.backupCodes.join('\n')} label="Copy codes" className="h-[38px]" />
          <Link to="/login" className={cn(buttonVariants(), 'h-[38px]')}>Sign in</Link>
        </>
      )}
    </AuthLayout>
  );
}

/** New password typed twice, so a typo does not lock the member out. Read it back with newPassword(). */
export function NewPasswordFields() {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="password">New password</FieldLabel>
        <Input id="password" name="password" type="password" className="h-[38px]" autoComplete="new-password" minLength={12} maxLength={128} required autoFocus />
        <FieldDescription>12 characters minimum</FieldDescription>
      </Field>
      <Field><FieldLabel htmlFor="confirm">Confirm password</FieldLabel><Input id="confirm" name="confirm" type="password" className="h-[38px]" autoComplete="new-password" required /></Field>
    </>
  );
}

export function newPassword(data: FormData) {
  if (data.get('password') !== data.get('confirm')) throw new Error("Passwords don't match.");
  return data.get('password');
}

export function StepForm({ title, lead, submit = 'Continue', children, onSubmit }: { title: string; lead?: string; submit?: string; children: ReactNode; onSubmit: (data: FormData) => Promise<void> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try { await onSubmit(new FormData(e.currentTarget)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  };
  return (
    <form className="flex flex-col gap-[18px]" onSubmit={send}>
      <AuthTitle title={title} lead={lead} />
      {children}
      <FormError>{error}</FormError>
      <Button type="submit" className="h-[38px]" disabled={busy}>{submit}</Button>
    </form>
  );
}

/** Three bars, the current step and those before it in ink. */
function Progress({ current }: { current: number }) {
  return (
    <div className="-mb-1 flex flex-col gap-2.5">
      <div aria-hidden className="grid grid-cols-3 gap-1">
        {[0, 1, 2].map((i) => <i key={i} className={cn('h-[3px] rounded-sm bg-line', i <= current && 'bg-ink')} />)}
      </div>
      <span className="text-[13px] text-ink-3">Step {current + 1} of 3</span>
    </div>
  );
}
