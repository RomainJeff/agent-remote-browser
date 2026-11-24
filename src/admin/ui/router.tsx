import type { QueryClient } from '@tanstack/react-query';
import { createHashHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { Shell } from '@/components/shell';
import { sessionQuery } from '@/lib/session';
import { InvitePage } from '@/pages/invite';
import { LoginPage } from '@/pages/login';

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

const index = createRoute({ getParentRoute: () => app, path: '/', beforeLoad: () => { throw redirect({ to: '/profiles' }); } });

const tree = root.addChildren([login, invite, app.addChildren([
  index, page('/profiles', 'Profiles'), page('/access', 'Agent access'), page('/members', 'Members'), page('/security', 'Account security'),
])]);

export const createAppRouter = (queryClient: QueryClient) => createRouter({ routeTree: tree, history: createHashHistory(), context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof createAppRouter> }
}
