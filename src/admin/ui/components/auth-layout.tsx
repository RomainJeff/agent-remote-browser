import type { ReactNode } from 'react';
import { CircleAlertIcon } from 'lucide-react';
import { Brand } from '@/components/brand';
import { cn } from '@/lib/utils';

/** Centered column of the sign-in, invitation and password screens: the mark and name, then one card. */
export function AuthLayout({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center gap-9 px-4 py-8">
      <Brand large />
      <div className="flex w-full max-w-[380px] flex-col gap-[18px] rounded-2xl border bg-card p-7">{children}</div>
      {foot}
    </section>
  );
}

/** Title of an auth card, with an optional line under it. */
export function AuthTitle({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{title}</h1>
      {lead && <p className="text-sm leading-[21px] text-ink-2">{lead}</p>}
    </div>
  );
}

/** Form error: ink with an icon, read out when it appears. */
export function FormError({ children, className }: { children?: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn('flex items-start gap-1.5 text-[13px] leading-5 font-medium', className)}>
      <CircleAlertIcon aria-hidden className="mt-[3px] size-3.5 flex-none" />{children}
    </p>
  );
}
