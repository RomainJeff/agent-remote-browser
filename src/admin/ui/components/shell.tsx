import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRoundIcon, LayoutListIcon, LogOutIcon, ShieldIcon, UsersIcon } from 'lucide-react';
import { Brand } from '@/components/brand';
import { Avatar } from '@/components/page';
import { driverOf } from '@/components/state';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { computersQuery } from '@/lib/queries';
import { gatewayAdminQuery, sessionQuery } from '@/lib/session';

/** Signed-in layout: sidebar on the canvas, page content in the main panel beside it. */
export function Shell({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient(), navigate = useNavigate();
  const { data: session } = useQuery(sessionQuery);
  const { data: gatewayAdmin } = useQuery(gatewayAdminQuery);
  const { data: computers } = useQuery(computersQuery);
  const email = session?.email ?? '';
  const needs = computers?.filter((c) => driverOf(c) === 'waiting').length ?? 0;
  useEffect(() => { document.title = (needs ? `(${needs}) ` : '') + 'Agent Remote Browser'; }, [needs]);
  const signOut = async () => {
    await api('/api/auth/sign-out', 'POST');
    queryClient.clear();
    await navigate({ to: '/login' });
  };
  return (
    <div className="flex min-h-screen flex-wrap">
      <aside className="flex max-w-full flex-[1_1_228px] flex-col gap-5 px-3 py-[18px] min-[900px]:sticky min-[900px]:top-0 min-[900px]:h-screen min-[900px]:flex-[0_0_228px]">
        <Brand />
        <nav className="flex flex-col gap-0.5" aria-label="Main navigation">
          <NavLink to="/profiles" icon={<LayoutListIcon />}>
            Profiles{needs > 0 && <span className="ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-full bg-needs-you px-[5px] text-[11.5px] font-bold text-ink" title="Agents waiting for you">{needs}</span>}
          </NavLink>
          <NavLink to="/access" icon={<KeyRoundIcon />}>Agent access</NavLink>
          {gatewayAdmin && <NavLink to="/members" icon={<UsersIcon />}>Members</NavLink>}
          <NavLink to="/security" icon={<ShieldIcon />}>Security</NavLink>
        </nav>
        <div className="mt-auto flex items-center gap-2.5 pl-2 text-[13px] text-ink-2">
          <Avatar email={email || 'AD'} className="size-6 text-[10.5px]" />
          <span className="min-w-0 flex-1 truncate">{email}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Sign out" title="Sign out" onClick={signOut}><LogOutIcon /></Button>
        </div>
      </aside>
      {/* PageHead's negative side margins match this padding. */}
      <main className="m-2 flex min-w-0 flex-[999_1_560px] flex-col gap-6 rounded-2xl border bg-card px-6 pb-10 min-[900px]:ml-0 max-[700px]:px-4">{children}</main>
    </div>
  );
}

function NavLink({ to, icon, children }: { to: '/profiles' | '/access' | '/members' | '/security'; icon: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 font-medium text-ink-2 hover:bg-line-soft [&_svg]:size-4"
      activeProps={{ 'aria-current': 'page', className: 'bg-line font-semibold text-ink hover:bg-line' }}>
      {icon}{children}
    </Link>
  );
}
