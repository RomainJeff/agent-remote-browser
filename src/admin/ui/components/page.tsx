import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Page title row: optional breadcrumb and subtitle on the left, actions on the right. */
export function PageHead({ title, crumb, sub, actions, mono }: { title: ReactNode; crumb?: ReactNode; sub?: ReactNode; actions?: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        {crumb && <span className="text-[13px] text-muted-foreground">{crumb}</span>}
        <h1 className={cn('text-[28px] leading-9 font-extrabold', mono && 'font-mono text-[26px] [overflow-wrap:anywhere]')} tabIndex={-1}>{title}</h1>
        {sub && <p className="max-w-[720px] text-base text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** White card. With a title, a header row (title, then hints and actions) sits above the content. */
export function Panel({ title, aside, children, className, pad, danger }: { title?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string; pad?: boolean; danger?: boolean }) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card', danger && 'border-[#F6B9A3]', className)}>
      {title && !pad && (
        <div className="flex flex-wrap items-center gap-3 border-b border-muted px-5 py-4">
          <h2 className="flex-auto text-base font-extrabold">{title}</h2>{aside}
        </div>
      )}
      {pad ? (
        <div className="flex min-w-0 flex-col gap-4 px-6 py-5">
          {title && <h2 className={cn('text-base font-extrabold', danger && 'text-destructive-ink')}>{title}</h2>}
          {children}
        </div>
      ) : children}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="px-5 py-6 text-muted-foreground">{children}</p>;
export const Hint = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn('text-xs text-muted-foreground', className)}>{children}</span>;

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border px-3.5 py-3 text-sm [&_code]:font-mono',
      kind === 'info' ? 'border-info-line bg-secondary text-primary' : 'border-warn-line bg-warn-soft text-warn-ink')}>{children}</div>
  );
}

/** Small grey line under a table cell's main value. */
export const Sub = ({ children, mono }: { children: ReactNode; mono?: boolean }) => <span className={cn('block text-xs text-muted-foreground', mono && 'font-mono')}>{children}</span>;
