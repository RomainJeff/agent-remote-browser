import { queryOptions } from '@tanstack/react-query';
import { api, ApiError } from './api';

export type Session = { email: string; stepUpRemainingS: number; mcpUrl: string };

const nullOn = (status: number) => (e: unknown) => {
  if (e instanceof ApiError && e.status === status) return null;
  throw e;
};

/** The signed-in admin (password + TOTP), or null: sign in first. */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: () => api<Session>('/api/session').catch(nullOn(401)),
  staleTime: 30_000,
});

/** Gateway admins manage members: /api/users answers them and refuses everyone else with 403. */
export const gatewayAdminQuery = queryOptions({
  queryKey: ['gateway-admin'],
  queryFn: () => api('/api/users').then(() => true, (e) => nullOn(403)(e) ?? false),
});
