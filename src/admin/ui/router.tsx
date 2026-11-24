import type { QueryClient } from '@tanstack/react-query';
import { createHashHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { Shell } from '@/components/shell';
import { toast } from 'sonner';
import { live } from '@/lib/live';
import { computersQuery } from '@/lib/queries';
import { sessionQuery } from '@/lib/session';
import { InvitePage } from '@/pages/invite';
import { LoginPage } from '@/pages/login';
import { ProfilePage } from '@/pages/profile';
import { ProfilesPage } from '@/pages/profiles';

// Hash history: links the server hands out (invites, handoffs) keep their token in the fragment, out of request logs.
const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

const login = createRoute({
  getParentRoute: () => root, path: '/login', component: LoginPage,
  beforeLoad: async ({ context }) => { if (await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: '/profiles' }); },
});

const invite = createRoute({
  getParentRoute: () => root, path: '/invite/$token',
  component: function Invite() { return <InvitePage token={invite.useParams().token} />; },
});

const app = createRoute({
  getParentRoute: () => root, id: 'app',
  beforeLoad: async ({ context }) => { if (!await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: '/login' }); },
  component: () => <Shell><Outlet /></Shell>,
});

const page = <P extends string>(path: P, title: string) => createRoute({
  getParentRoute: () => app, path, component: () => <h1 className="text-[28px] leading-9 font-extrabold">{title}</h1>,
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

const tree = root.addChildren([login, invite, app.addChildren([
  index, profiles, profile, handoff, page('/access', 'Agent access'), page('/members', 'Members'), page('/security', 'Account security'),
])]);

export const createAppRouter = (queryClient: QueryClient) => createRouter({ routeTree: tree, history: createHashHistory(), context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof createAppRouter> }
}
