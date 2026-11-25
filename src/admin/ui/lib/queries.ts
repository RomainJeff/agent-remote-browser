import { queryOptions } from '@tanstack/react-query';
import { api } from './api';
import type { Clients, Computer, Details, GatewayUser, Invite, Member } from './types';

export const profilePath = (id: string) => `/api/computers/${encodeURIComponent(id)}`;

// Same cadence as before: the list every 3 s, a profile's details every 5 s.
export const computersQuery = queryOptions({ queryKey: ['computers'], queryFn: () => api<Computer[]>('/api/computers'), refetchInterval: 3000 });
export const detailsQuery = (id: string) => queryOptions({ queryKey: ['computers', id], queryFn: () => api<Details>(profilePath(id)), refetchInterval: 5000 });
export const clientsQuery = queryOptions({ queryKey: ['clients'], queryFn: () => api<Clients>('/api/clients') });
export const usersQuery = queryOptions({ queryKey: ['users'], queryFn: () => api<GatewayUser[]>('/api/users'), refetchInterval: 5000 });
export const invitesQuery = queryOptions({ queryKey: ['users', 'invites'], queryFn: () => api<Invite[]>('/api/users/invites'), refetchInterval: 5000 });
export const membersQuery = (id: string) => queryOptions({ queryKey: ['computers', id, 'members'], queryFn: () => api<Member[]>(`${profilePath(id)}/members`), refetchInterval: 5000 });
export const candidatesQuery = (id: string) => queryOptions({ queryKey: ['computers', id, 'candidates'], queryFn: () => api<string[]>(`${profilePath(id)}/candidates`), refetchInterval: 5000 });
