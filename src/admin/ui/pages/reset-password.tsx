import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AuthLayout } from '@/components/auth-layout';
import { Card } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { StepForm } from '@/pages/invite';

/** One-time link from a gateway admin: choose a new password, then sign in as usual (password and authenticator code). */
export function ResetPasswordPage({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  return (
    <AuthLayout>
      <Card className="w-full max-w-[420px] gap-5 p-8">
        {done ? (
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-extrabold">Password changed</h1>
            <Link to="/login" className="font-semibold text-primary">Sign in</Link>
          </div>
        ) : (
          <StepForm title="Reset password" onSubmit={async (data) => {
            await api('/api/password/reset', 'POST', { token, password: data.get('password') });
            setDone(true);
          }}>
            <Field><FieldLabel htmlFor="password">New password</FieldLabel><Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required autoFocus /></Field>
          </StepForm>
        )}
      </Card>
    </AuthLayout>
  );
}
