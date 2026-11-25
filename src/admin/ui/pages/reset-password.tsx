import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AuthLayout } from '@/components/auth-layout';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { NewPasswordFields, newPassword, StepForm } from '@/pages/invite';

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
            await api('/api/password/reset', 'POST', { token, password: newPassword(data) });
            setDone(true);
          }}>
            <NewPasswordFields />
          </StepForm>
        )}
      </Card>
    </AuthLayout>
  );
}
