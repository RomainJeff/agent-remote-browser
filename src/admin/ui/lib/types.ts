// Shapes of the admin API replies (src/admin/routes.ts: listComputers, computerDetails, members), written by hand.
export type Role = 'viewer' | 'editor' | 'admin';

export type Computer = {
  id: string; role: Role; members: number; container: string;
  state: 'running' | 'exited' | 'none'; status: string; profile: boolean;
  allow: string[]; logins: string[];
  leasedUntil: string | null;
  lastCall: { ts: string; tool: string; ok: boolean } | null;
  idleStopInS: number | null; viewers: number;
  handoff: { id: string; state: 'pending' | 'taken'; reason: string; created: string; deadline: string } | null;
};

export type Login = { site: string; url: string; username: string; lastTestedAt: string | null; lastResult: 'ok' | 'fail' | null };
export type Header = { origin: string; name: string };
export type Playbook = { name: string; body: string; description: string; updated: string };
export type Cookie = { name: string; domain: string; expires: number; session?: boolean; httpOnly?: boolean; secure?: boolean };
export type AuditEntry = { ts: string; tool: string; ok: boolean; ms?: number; via?: string; err?: string };

export type Details = {
  id: string; running: boolean; page: { url: string; title: string } | null;
  logins: Login[]; headers: Header[]; playbooks: Playbook[];
  cookies: Cookie[]; storage: { origin: string; localStorageKeys: number }[]; audit: AuditEntry[];
};

export type Member = { email: string; role: Role };
/** scopes: the profiles (profile:<id>) or global the client was granted, comma-separated. */
export type OAuthClient = { id: string; name: string | null; createdAt: string; scopes: string | null; lastToken: string | null };
/** noExpiry: a key from before expiry was required, to replace. */
export type ApiKey = { id: string; name: string; start: string; scope: string | null; createdAt: string; lastRequest: string | null; lastIp: string | null; expiresAt: string | null; noExpiry: boolean };
export type Clients = { oauth: OAuthClient[]; keys: ApiKey[] };

export type GatewayUser = { email: string; admin: boolean; twoFactorEnabled: boolean; createdAt: string; pending: boolean; privateProfileCount: number };
export type Invite = { id: string; email: string; admin: boolean; created: number; expires: number; createdBy: string | null };
