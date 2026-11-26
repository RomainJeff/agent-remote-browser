import type { ReactNode } from 'react';
import { AccountButton } from '@/components/account';
import { cn } from '@/lib/utils';

/** Header bar at the top of the main panel: optional breadcrumb then title on the left, actions on the right.
 * On a phone, top-level pages (no breadcrumb) also get the account button.
 * Its negative side margins cancel the main panel's padding (Shell), so the bar and its border span the panel. */
export function PageHead({ title, crumb, sub, actions, mono }: { title: ReactNode; crumb?: ReactNode; sub?: ReactNode; actions?: ReactNode; mono?: boolean }) {
  return (
    <>
      <div className="-mx-6 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2.5 max-[700px]:-mx-4 max-[700px]:px-4">
        <div className="flex min-w-0 flex-[1_1_320px] items-center gap-2 text-[15px]">
          {crumb && <><span className="font-medium text-muted-foreground">{crumb}</span><span className="text-input">/</span></>}
          <h1 className={cn('font-semibold', mono && 'font-mono text-sm [overflow-wrap:anywhere]')} tabIndex={-1}>{title}</h1>
          {!crumb && <AccountButton />}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {sub && <p className="-mt-2 max-w-[720px] text-ink-2">{sub}</p>}
    </>
  );
}

/** White card. With a title, a header row (title, then hints and actions) sits above the content. */
export function Panel({ title, aside, children, className, pad }: { title?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card', className)}>
      {title && !pad && (
        <div className="flex flex-wrap items-center gap-3 border-b border-muted px-5 py-4">
          <h2 className="flex-auto text-sm font-semibold">{title}</h2>{aside}
        </div>
      )}
      {pad ? (
        <div className="flex min-w-0 flex-col gap-4 px-6 py-5">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {children}
        </div>
      ) : children}
    </section>
  );
}

/** A titled part of a tab, without a card: title and one line under it on the left, actions on the right, then the content. */
export function Section({ title, lead, actions, children, className }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4', className)}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {lead && <p className="max-w-[720px] text-[13.5px] leading-5 text-ink-2">{lead}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="px-5 py-6 text-muted-foreground">{children}</p>;
export const Hint = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn('text-xs text-muted-foreground', className)}>{children}</span>;

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'danger'; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border px-3.5 py-3 text-sm [&_code]:font-mono', {
      info: 'bg-surface-2', warn: 'border-input bg-surface-2 font-medium', danger: 'border-input bg-surface-2 font-medium',
    }[kind])}>{children}</div>
  );
}

/** Small grey line under a table cell's main value. */
export const Sub = ({ children, mono }: { children: ReactNode; mono?: boolean }) => <span className={cn('block text-xs text-muted-foreground', mono && 'font-mono')}>{children}</span>;
