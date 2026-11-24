import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { ActionButton } from '@/components/action-button';
import { PageHead } from '@/components/page';
import { StatePill } from '@/components/state';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { computersQuery, detailsQuery, profilePath } from '@/lib/queries';
import type { Computer } from '@/lib/types';
import { DiagnosticsTab } from './diagnostics';
import { DomainsTab } from './domains';
import { LoginsTab } from './logins';
import { PlaybooksTab } from './playbooks';
import { SessionTab } from './session';
import { SettingsTab } from './settings';
import { SharingTab } from './sharing';

export const TABS = { session: 'Session', logins: 'Logins', playbooks: 'Playbooks', domains: 'Domains', diagnostics: 'Diagnostics', sharing: 'Sharing', settings: 'Settings' } as const;
export type Tab = keyof typeof TABS;

const tabsFor = (c: Computer) => (Object.keys(TABS) as Tab[]).filter((t) => (t !== 'settings' || c.role === 'admin')
  && (c.role !== 'viewer' || ['session', 'diagnostics', 'sharing'].includes(t)));

export function ProfilePage({ id, tab }: { id: string; tab?: string }) {
  const { data: computers, isPending } = useQuery(computersQuery);
  const queryClient = useQueryClient();
  const c = computers?.find((x) => x.id === id);
  const { data: details } = useQuery({ ...detailsQuery(id), enabled: !!c });
  const crumb = (rest: React.ReactNode) => <><Link to="/profiles" className="font-semibold text-primary">Profiles</Link> › {rest}</>;
  if (isPending) return null;
  if (!c) return <PageHead crumb={crumb(id)} title="Profile not found" sub={`${id} doesn't exist or was deleted.`} />;
  const tabs = tabsFor(c);
  // A tab this role does not get (or a mistyped one): the session, with the URL saying so.
  if (tab && !tabs.includes(tab as Tab)) return <Navigate to="/profiles/$id" params={{ id }} replace />;
  const current = (tab ?? 'session') as Tab;
  const count: Partial<Record<Tab, number>> = { logins: c.logins.length, playbooks: details?.playbooks.length, domains: c.allow.length };

  return (
    <>
      <PageHead mono crumb={crumb(<span className="font-mono">{id}</span>)}
        title={<span className="flex flex-wrap items-center gap-3">{id}<span className="flex gap-2 font-sans"><StatePill c={c} />{c.leasedUntil && <Badge dot variant="agent">Agent lease</Badge>}</span></span>}
        actions={c.role !== 'viewer' && (
          <ActionButton variant="outline" size="lg" disabled={c.state !== 'running'} done="Browser stopped. The profile is kept."
            action={async () => { await api(`${profilePath(id)}/stop`, 'POST'); await queryClient.invalidateQueries({ queryKey: ['computers'] }); }}>Stop browser</ActionButton>
        )} />
      <nav className="-mb-2 flex gap-1 overflow-x-auto border-b" aria-label="Profile sections">
        {tabs.map((t) => (
          <Link key={t} to="/profiles/$id" params={{ id }} search={{ tab: t === 'session' ? undefined : t }} activeOptions={{ exact: true }}
            className="-mb-px border-b-2 border-transparent px-3.5 py-2.5 font-semibold whitespace-nowrap text-muted-foreground hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:font-bold aria-[current=page]:text-primary">
            {TABS[t]}{count[t] !== undefined && ` · ${count[t]}`}
          </Link>
        ))}
      </nav>
      {current === 'session' && <SessionTab c={c} />}
      {current === 'logins' && <LoginsTab id={id} />}
      {current === 'playbooks' && <PlaybooksTab id={id} />}
      {current === 'domains' && <DomainsTab c={c} />}
      {current === 'diagnostics' && <DiagnosticsTab c={c} />}
      {current === 'sharing' && <SharingTab c={c} />}
      {current === 'settings' && <SettingsTab id={id} />}
    </>
  );
}
