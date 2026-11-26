import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { KeyRoundIcon, LayoutListIcon, LogOutIcon, ShieldIcon, UsersIcon, type LucideIcon } from 'lucide-react';
import { Avatar, useSignOut } from '@/components/account';
import { Brand } from '@/components/brand';
import { driverOf } from '@/components/state';
import { Button } from '@/components/ui/button';
import { computersQuery } from '@/lib/queries';
import { gatewayAdminQuery, sessionQuery } from '@/lib/session';
import { cn } from '@/lib/utils';

type Item = { to: '/profiles' | '/access' | '/members' | '/security'; label: string; Icon: LucideIcon };

/** Signed-in layout: sidebar on the canvas and the page in the main panel beside it. Under 900px the sidebar
 *  becomes a tab bar at the bottom, hidden inside a profile, which has its own tabs and needs the height. */
export function Shell({ children }: { children: ReactNode }) {
  const { data: session } = useQuery(sessionQuery);
  const { data: gatewayAdmin } = useQuery(gatewayAdminQuery);
  const { data: computers } = useQuery(computersQuery);
  const signOut = useSignOut();
  const inProfile = useRouterState({ select: (s) => s.location.pathname.startsWith('/profiles/') });
  const email = session?.email ?? '';
  const needs = computers?.filter((c) => driverOf(c) === 'waiting').length ?? 0;
  useEffect(() => { document.title = (needs ? `(${needs}) ` : '') + 'Agent Remote Browser'; }, [needs]);
  const items: Item[] = [
    { to: '/profiles', label: 'Profiles', Icon: LayoutListIcon },
    { to: '/access', label: 'Agent access', Icon: KeyRoundIcon },
    ...(gatewayAdmin ? [{ to: '/members', label: 'Members', Icon: UsersIcon } as const] : []),
    { to: '/security', label: 'Security', Icon: ShieldIcon },
  ];
  const badge = (className: string) => needs > 0 && <span className={cn('grid h-[18px] min-w-[18px] place-items-center rounded-full bg-needs-you px-[5px] text-[11.5px] font-bold text-ink', className)} title="Agents waiting for you">{needs}</span>;
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen flex-[0_0_228px] flex-col gap-5 px-3 py-[18px] max-[900px]:hidden">
        <Brand />
        <nav className="flex flex-col gap-0.5" aria-label="Main navigation">
          {items.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 font-medium text-ink-2 hover:bg-line-soft [&_svg]:size-4"
              activeProps={{ 'aria-current': 'page', className: 'bg-line font-semibold text-ink hover:bg-line' }}>
              <Icon />{label}{to === '/profiles' && badge('ml-auto')}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2.5 pl-2 text-[13px] text-ink-2">
          <Avatar email={email || 'AD'} className="size-6 text-[10.5px]" />
          <span className="min-w-0 flex-1 truncate">{email}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Sign out" title="Sign out" onClick={signOut}><LogOutIcon /></Button>
        </div>
      </aside>
      {/* PageHead's negative side margins match this padding. */}
      <main className={cn('m-2 flex min-w-0 flex-auto flex-col gap-6 rounded-2xl border bg-card px-6 pb-10 min-[900px]:ml-0 max-[700px]:px-4',
        !inProfile && 'max-[900px]:mb-[calc(64px+env(safe-area-inset-bottom))]')}>{children}</main>
      {!inProfile && (
        <nav aria-label="Main navigation" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card pb-[env(safe-area-inset-bottom)] min-[900px]:hidden">
          {items.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className="relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11.5px] font-medium whitespace-nowrap text-ink-3 [&_svg]:size-[22px] [&_svg]:stroke-[1.8]"
              activeProps={{ 'aria-current': 'page', className: 'font-semibold text-ink before:absolute before:-top-px before:h-0.5 before:w-7 before:rounded-b-sm before:bg-ink' }}>
              <span className="relative"><Icon />{to === '/profiles' && badge('absolute -top-1.5 left-3.5 h-[19px] min-w-[19px] border-2 border-card text-[10.5px]')}</span>
              {label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
