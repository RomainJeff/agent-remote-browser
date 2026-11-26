import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { ActionButton } from '@/components/action-button';
import { PageHead } from '@/components/page';
import { api } from '@/lib/api';
import { closeView } from '@/lib/live';
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
  // Leaving the profile (or opening another) closes its view and ends a recording.
  useEffect(() => () => closeView(), [id]);
  const crumb = <Link to="/profiles">Profiles</Link>;
  if (isPending) return null;
  if (!c) return <PageHead crumb={crumb} title="Profile not found" sub={`${id} doesn't exist or was deleted.`} />;
  const tabs = tabsFor(c);
  // A tab this role does not get (or a mistyped one): the session, with the URL saying so.
  if (tab && !tabs.includes(tab as Tab)) return <Navigate to="/profiles/$id" params={{ id }} replace />;
  const current = (tab ?? 'session') as Tab;
  const count: Partial<Record<Tab, number>> = { logins: c.logins.length, playbooks: details?.playbooks.length, domains: c.allow.length };

  return (
    <>
      <PageHead mono crumb={crumb}
        title={id}
        actions={c.role !== 'viewer' && (
          <ActionButton variant="outline" size="lg" disabled={c.state !== 'running'} done="Browser stopped. The profile is kept."
            action={async () => { closeView(); await api(`${profilePath(id)}/stop`, 'POST'); await queryClient.invalidateQueries({ queryKey: ['computers'] }); }}>Stop browser</ActionButton>
        )} />
      <nav className="-mb-2 flex gap-[22px] overflow-x-auto border-b" aria-label="Profile sections">
        {tabs.map((t) => (
          <Link key={t} to="/profiles/$id" params={{ id }} search={{ tab: t === 'session' ? undefined : t }} activeOptions={{ exact: true }}
            className="-mb-px flex h-[42px] items-center gap-1.5 border-b-2 border-transparent px-0.5 text-[13.5px] font-medium whitespace-nowrap text-ink-2 hover:text-ink aria-[current=page]:border-ink aria-[current=page]:font-semibold aria-[current=page]:text-ink">
            {TABS[t]}{count[t] !== undefined && <span className="font-medium text-ink-3 tabular-nums">{count[t]}</span>}
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
