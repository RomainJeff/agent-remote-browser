import type { ReactNode } from 'react';

/** Centered column of the sign-in and invitation screens. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return <section className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-8">{children}</section>;
}

/** Form error, read out when it appears. */
export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <div role="alert" className="rounded-lg border border-input bg-surface-2 px-3.5 py-3 font-medium">{children}</div>;
}
