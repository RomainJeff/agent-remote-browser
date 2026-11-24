import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRoundIcon, LayoutListIcon, LogOutIcon, ShieldIcon, UsersIcon } from 'lucide-react';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { gatewayAdminQuery, sessionQuery } from '@/lib/session';

/** Signed-in layout: sidebar navigation and the account, page content beside it. */
export function Shell({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient(), navigate = useNavigate();
  const { data: session } = useQuery(sessionQuery);
  const { data: gatewayAdmin } = useQuery(gatewayAdminQuery);
  const email = session?.email ?? '';
  const signOut = async () => {
    await api('/api/auth/sign-out', 'POST');
    queryClient.clear();
    await navigate({ to: '/login' });
  };
  return (
    <div className="flex min-h-screen flex-wrap">
      <aside className="flex max-w-full flex-[1_1_232px] flex-col gap-6 border-r border-[#E0E0E0] bg-card px-4 py-5 min-[900px]:sticky min-[900px]:top-0 min-[900px]:h-screen min-[900px]:flex-[0_0_232px]">
        <Brand />
        <nav className="flex flex-col gap-1" aria-label="Main navigation">
          <NavLink to="/profiles" icon={<LayoutListIcon />}>Profiles</NavLink>
          <NavLink to="/access" icon={<KeyRoundIcon />}>Agent access</NavLink>
          {gatewayAdmin && <NavLink to="/members" icon={<UsersIcon />}>Members</NavLink>}
          <NavLink to="/security" icon={<ShieldIcon />}>Security</NavLink>
        </nav>
        <header className="mt-auto flex items-center gap-3 border-t border-muted pt-4">
          <span className="flex size-8 flex-none items-center justify-center rounded-full bg-muted text-xs font-bold">{(email || 'AD').slice(0, 2).toUpperCase()}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <b className="truncate text-[13px]">{email}</b>
            <span className="text-xs font-semibold text-primary">2FA enabled</span>
          </span>
          <Button variant="ghost" size="icon-lg" aria-label="Sign out" title="Sign out" onClick={signOut}><LogOutIcon /></Button>
        </header>
      </aside>
      <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-6 px-10 pt-8 pb-12 max-[700px]:px-4 max-[700px]:pt-6">{children}</main>
    </div>
  );
}

function NavLink({ to, icon, children }: { to: '/profiles' | '/access' | '/members' | '/security'; icon: ReactNode; children: string }) {
  return (
    <Link to={to} className="flex min-h-10 items-center gap-3 rounded-lg px-3 font-semibold text-foreground hover:bg-background [&_svg]:size-[18px]"
      activeProps={{ 'aria-current': 'page', className: 'bg-secondary text-primary font-bold hover:bg-secondary' }}>
      {icon}{children}
    </Link>
  );
}
