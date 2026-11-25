import type { QueryClient } from '@tanstack/react-query';
import { createHashHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { Shell } from '@/components/shell';
import { toast } from 'sonner';
import { live } from '@/lib/live';
import { computersQuery } from '@/lib/queries';
import { gatewayAdminQuery, sessionQuery } from '@/lib/session';
import { AccessPage } from '@/pages/access';
import { MembersPage } from '@/pages/members';
import { SecurityPage } from '@/pages/security';
import { InvitePage } from '@/pages/invite';
import { LoginPage } from '@/pages/login';
import { ProfilePage } from '@/pages/profile';
import { ProfilesPage } from '@/pages/profiles';
import { ResetPasswordPage } from '@/pages/reset-password';

// Hash history: links the server hands out (invites, password resets, handoffs) keep their token in the fragment, out of request logs.
const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

const login = createRoute({
  getParentRoute: () => root, path: '/login', component: LoginPage,
  beforeLoad: async ({ context }) => { if (await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: '/profiles' }); },
});

const invite = createRoute({
  getParentRoute: () => root, path: '/invite/$token',
  component: function Invite() { return <InvitePage token={invite.useParams().token} />; },
});

const resetPassword = createRoute({
  getParentRoute: () => root, path: '/reset-password/$token',
  component: function ResetPassword() { return <ResetPasswordPage token={resetPassword.useParams().token} />; },
});

const app = createRoute({
  getParentRoute: () => root, id: 'app',
  beforeLoad: async ({ context }) => { if (!await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: '/login' }); },
  component: () => <Shell><Outlet /></Shell>,
});

const access = createRoute({ getParentRoute: () => app, path: '/access', component: AccessPage });
const security = createRoute({ getParentRoute: () => app, path: '/security', component: SecurityPage });
const members = createRoute({
  getParentRoute: () => app, path: '/members', component: MembersPage,
  beforeLoad: async ({ context }) => { if (!await context.queryClient.ensureQueryData(gatewayAdminQuery)) throw redirect({ to: '/profiles' }); },
});

const profiles = createRoute({ getParentRoute: () => app, path: '/profiles', component: ProfilesPage });

const profile = createRoute({
  getParentRoute: () => app, path: '/profiles/$id',
  validateSearch: (s: Record<string, unknown>): { tab?: string } => typeof s.tab === 'string' ? { tab: s.tab } : {},
  component: function Profile() { return <ProfilePage id={profile.useParams().id} tab={profile.useSearch().tab} />; },
});

// Handoff link given to the agent's user: its profile, Take over focused. No automatic takeover.
const handoff = createRoute({
  getParentRoute: () => app, path: '/handoff/$id',
  beforeLoad: async ({ context, params }) => {
    const c = (await context.queryClient.fetchQuery(computersQuery)).find((x) => x.handoff?.id === params.id);
    if (!c) { toast.error('This request is already closed'); throw redirect({ to: '/profiles', replace: true }); }
    live.focusTakeOver = true;
    throw redirect({ to: '/profiles/$id', params: { id: c.id }, replace: true });
  },
});

const index = createRoute({ getParentRoute: () => app, path: '/', beforeLoad: () => { throw redirect({ to: '/profiles' }); } });

const tree = root.addChildren([login, invite, resetPassword, app.addChildren([
  index, profiles, profile, handoff, access, members, security,
])]);

export const createAppRouter = (queryClient: QueryClient) => createRouter({ routeTree: tree, history: createHashHistory(), context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof createAppRouter> }
}
