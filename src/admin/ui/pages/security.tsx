import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { CopyButton } from '@/components/mcp-url';
import { PageHead, Section } from '@/components/page';
import { NumberedStep } from '@/components/step-text';
import { sessionQuery } from '@/lib/session';

/** A command to run on the host, in a dark block with Copy. */
const Command = ({ text }: { text: string }) => (
  <div className="flex items-stretch overflow-hidden rounded-xl bg-ink">
    <pre className="min-w-0 flex-auto px-4 py-3.5 font-mono text-[12.5px] leading-5 whitespace-pre-wrap text-canvas [overflow-wrap:anywhere]"><span className="text-ink-3 select-none">$ </span>{text}</pre>
    <CopyButton text={text} className="h-auto w-[76px] flex-none rounded-none border-0 border-l border-l-white/15 bg-transparent text-canvas hover:bg-white/10 hover:text-white" />
  </div>
);

const Tip = ({ children }: { children: ReactNode }) => (
  <li className="grid grid-cols-[6px_minmax(0,1fr)] gap-2.5 border-b border-line-soft py-3 text-[13.5px] leading-5">
    <i aria-hidden className="mt-[7px] size-1.5 rounded-full bg-line-strong" />{children}
  </li>
);

/** Two-step sign-in is managed on the host (CLI): this page says it is on and how to reset it. */
export function SecurityPage() {
  const { data: session } = useQuery(sessionQuery);
  const email = session?.email || 'admin@example.com', reset = `docker compose exec gateway node src/cli.ts admin reset-2fa ${email}`;
  return (
    <>
      <PageHead title="Security" />
      <div className="grid max-w-[1140px] items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-7">
          <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border p-[18px]">
            <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheckIcon aria-hidden className="size-4" />Two-step sign-in is on</h2>
              <p className="text-[13.5px] text-ink-2">Authenticator app, {email}</p>
            </div>
            <dl className="flex gap-8">
              {[['Backup codes', '10, single use'], ['Lockout', '5 tries, then 15 min']].map(([t, d]) => (
                <div key={t}><dt className="text-[13px] text-ink-3">{t}</dt><dd className="mt-0.5 font-medium">{d}</dd></div>
              ))}
            </dl>
          </section>
          <Section title="New phone or new backup codes" lead="Done on the server, not in the browser: access to its terminal proves it's you. Also works if you lost both your phone and your codes.">
            <Command text={reset} />
            <ol className="-mt-1 border-t border-line-soft">
              <NumberedStep n={1}>Choose a new password, 12 characters minimum</NumberedStep>
              <NumberedStep n={2}>Scan the QR code in the terminal with your authenticator app</NumberedStep>
              <NumberedStep n={3}>Enter a first code, then save the 10 new backup codes</NumberedStep>
              <NumberedStep n={4}>All admin sessions end. <b className="font-semibold">You will be signed out here.</b></NumberedStep>
            </ol>
          </Section>
        </div>
        <aside aria-labelledby="tips" className="flex flex-col">
          <h2 id="tips" className="pb-1 text-sm font-semibold">Good to know</h2>
          <ul>
            <Tip>Keep backup codes offline, away from your phone.</Tip>
            <Tip>The QR code and setup key hold the secret. Never paste them in a chat or a ticket.</Tip>
            <Tip>Changing domains, saved logins, keys or deleting asks for a code again after 15 min. Five wrong codes end the session.</Tip>
          </ul>
          <details className="py-3 text-[13.5px]">
            <summary className="cursor-pointer font-medium text-ink-2">Fresh install: create the admin</summary>
            <div className="mt-3 flex flex-col gap-2">
              <Command text="docker compose exec gateway node src/cli.ts admin create you@example.com" />
              <p className="text-[13px] text-ink-3">Only on an empty gateway. Same steps: password, QR code, first code, backup codes.</p>
            </div>
          </details>
        </aside>
      </div>
    </>
  );
}
