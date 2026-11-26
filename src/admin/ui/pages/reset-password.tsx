import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { AuthLayout, AuthTitle } from '@/components/auth-layout';
import { buttonVariants } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { NewPasswordFields, newPassword, StepForm } from '@/pages/invite';

/** One-time link from a gateway admin: choose a new password, then sign in as usual (password and authenticator code). */
export function ResetPasswordPage({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  return (
    <AuthLayout>
      {done ? (
        <>
          <span className="grid size-9 place-items-center rounded-full bg-line-soft"><CheckIcon aria-hidden className="size-[18px]" strokeWidth={2.4} /></span>
          <AuthTitle title="Password changed" lead="Sign in with it and your authenticator code." />
          <Link to="/login" className={cn(buttonVariants(), 'h-[38px]')}>Sign in</Link>
        </>
      ) : (
        <StepForm title="Choose a new password" lead="Your authenticator app stays the same." submit="Save password" onSubmit={async (data) => {
          await api('/api/password/reset', 'POST', { token, password: newPassword(data) });
          setDone(true);
        }}>
          <NewPasswordFields />
        </StepForm>
      )}
    </AuthLayout>
  );
}
