import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { CopyButton } from '@/components/mcp-url';
import { Hint, PageHead, Panel } from '@/components/page';
import { sessionQuery } from '@/lib/session';
import { cn } from '@/lib/utils';

const Term = ({ children, className }: { children: ReactNode; className?: string }) => (
  <pre className={cn('overflow-auto rounded-lg bg-[#1F2226] p-3 font-mono text-xs whitespace-pre-wrap text-[#E9EBEC] [overflow-wrap:anywhere]', className)}>{children}</pre>
);

/** 2FA is managed on the host (CLI): this page only explains how. */
export function SecurityPage() {
  const { data: session } = useQuery(sessionQuery);
  const email = session?.email || 'admin@example.com', reset = `docker compose exec gateway node src/cli.ts admin reset-2fa ${email}`;
  return (
    <>
      <PageHead title="Account security" sub="Two-factor authentication is managed from the host machine, on the command line. Access to the server's terminal proves it's you." />
      <section className="flex flex-wrap items-center gap-5 rounded-xl border bg-card px-6 py-5">
        <span className="flex size-12 items-center justify-center rounded-xl bg-secondary text-primary"><ShieldCheckIcon className="size-6" /></span>
        <div className="flex min-w-0 flex-[1_1_260px] flex-col">
          <h2 className="text-base font-extrabold">Two-factor authentication is on</h2>
          <span className="text-sm text-muted-foreground">Authenticator app (TOTP) · {email}</span>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {[['Enabled', 'by the CLI, when the account was created'], ['Backup codes', '10 generated, single use'], ['Lockout', '5 attempts, then 15 min']].map(([t, d]) => (
            <div key={t}><dt className="text-xs font-bold text-muted-foreground">{t}</dt><dd className="font-semibold">{d}</dd></div>
          ))}
        </dl>
      </section>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] items-start gap-6">
        <Panel pad title="Change phone or regenerate codes">
          <p className="-mt-3 text-muted-foreground">Also if you have lost both your phone and your backup codes.</p>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-bold text-muted-foreground">On the host machine</span>
            <div className="flex gap-2"><Term className="flex-auto">{reset}</Term><CopyButton text={reset} /></div>
          </div>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li>Asks for a new password (12 characters minimum)</li>
            <li>Shows a QR code to scan with your authenticator app, once</li>
            <li>Checks a first code, then shows 10 new backup codes</li>
            <li>Ends all admin sessions: <strong>you will be signed out here</strong></li>
          </ol>
        </Panel>
        <Panel pad title="Good practices">
          <p>Keep backup codes offline, somewhere other than your phone.</p>
          <p>The otpauth:// link contains the secret: never paste it into a chat or a ticket.</p>
          <p>No server access? Nobody can reset 2FA from the browser. That is by design.</p>
          <p>Sensitive actions (domains, saved logins, keys, deletion) ask for a code again every 15 min. Five wrong codes end the session.</p>
          <details className="border-t border-muted pt-2">
            <summary className="cursor-pointer font-semibold text-primary">Fresh install: create the admin</summary>
            <Term className="mt-2.5">docker compose exec gateway node src/cli.ts admin create you@example.com</Term>
            <Hint className="mt-1.5 block">One admin per gateway. Same steps: password, QR code, first code, backup codes.</Hint>
          </details>
        </Panel>
      </div>
    </>
  );
}
