import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Auth } from './better-auth.ts';
import { tx } from '../store/db.ts';
import type { Audit } from '../audit.ts';

export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function normalizedEmail(email: unknown) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new AccountError(400, 'Invalid email');
  return email.toLowerCase();
}

export function pendingEmail(db: DatabaseSync, email: string) {
  return !!db.prepare('SELECT 1 FROM pending_emails WHERE email = ?').get(email);
}

export function requireAvailable(db: DatabaseSync, email: string) {
  if (pendingEmail(db, email)) throw new AccountError(409, 'Revoke the pending invite first');
}

export function userId(db: DatabaseSync, email: string) {
  email = normalizedEmail(email);
  requireAvailable(db, email);
  const row = db.prepare('SELECT id FROM user WHERE email = ?').get(email);
  if (!row) throw new AccountError(404, `No user ${email}`);
  return row.id as string;
}

export async function passwordHash(auth: Auth, password: unknown) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw new AccountError(400, 'Password: 12 to 128 characters');
  return (await auth.$context).password.hash(password);
}

// The caller owns the transaction, including any invite check and abandoned account cleanup.
export function createCredential(db: DatabaseSync, email: string, hashed: string, admin: boolean) {
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .run(id, email, admin ? 'Admin' : 'User', now, now);
  db.prepare("INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt) VALUES (?, ?, ?, 'credential', ?, ?, ?)")
    .run(randomUUID(), id, id, hashed, now, now);
  if (admin) db.prepare('INSERT INTO admins VALUES (?)').run(id);
  return id;
}

export async function startTotp(auth: Auth, email: string, password: string) {
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookies = signIn.headers.getSetCookie();
  const headers = new Headers({ cookie: cookies.map((c) => c.split(';')[0]).join('; ') });
  const enrolled = await auth.api.enableTwoFactor({ body: { password }, headers });
  if (!('totpURI' in enrolled)) throw Error('TOTP enrollment failed');
  return { ...enrolled, cookies, headers };
}

export function verifyTotp(auth: Auth, headers: Headers, code: string) {
  return auth.api.verifyTOTP({ body: { code }, headers });
}

export function deleteSessions(db: DatabaseSync, id: string) {
  db.prepare('DELETE FROM session WHERE userId = ?').run(id);
}

const privateProfiles = `SELECT profile, user_id FROM profile_members GROUP BY profile HAVING count(*) = 1`;

export function privateProfilesOf(db: DatabaseSync, id: string) {
  return db.prepare(`SELECT profile FROM (${privateProfiles}) WHERE user_id = ?`).all(id)
    .map(row => String(row.profile));
}

function keepGatewayAdmin(db: DatabaseSync, id: string) {
  if (db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(id) &&
    !db.prepare('SELECT 1 FROM admins JOIN user ON user.id = user_id WHERE user_id != ? AND email NOT IN pending_emails').get(id))
    throw new AccountError(409, 'Cannot remove the last gateway admin');
}

export function removalTarget(db: DatabaseSync, email: string) {
  const id = userId(db, email);
  keepGatewayAdmin(db, id);
  return id;
}

export function removeUser(db: DatabaseSync, email: string, by: string, audit: Audit) {
  const promoted = tx(db, () => {
    const id = removalTarget(db, email);
    if (privateProfilesOf(db, id).length)
      throw new AccountError(409, 'Remove this member from the admin UI or delete their private profiles first');
    const rows = db.prepare(`UPDATE profile_members SET role = 'admin' WHERE rowid IN (
      SELECT min(other.rowid) FROM profile_members departing JOIN profile_members other USING (profile)
      WHERE departing.user_id = ? AND departing.role = 'admin' AND other.user_id != ?
      GROUP BY profile HAVING max(other.role = 'admin') = 0
    ) RETURNING profile, (SELECT email FROM user WHERE id = profile_members.user_id) AS email`).all(id, id);
    db.prepare('DELETE FROM apikey WHERE referenceId = ?').run(id);
    db.prepare('DELETE FROM user WHERE id = ?').run(id);
    return rows;
  });
  for (const row of promoted)
    audit({ by, agent: String(row.profile), member: String(row.email), tool: 'admin:member_promote', ok: true });
  audit({ by, agent: email, tool: 'admin:user_remove', ok: true });
}

export function listUsers(db: DatabaseSync) {
  return db.prepare(`SELECT email, admins.user_id IS NOT NULL AS admin, twoFactorEnabled, createdAt,
    email IN pending_emails AS pending, (SELECT count(*) FROM (${privateProfiles}) WHERE user_id = user.id) AS privateProfileCount FROM user LEFT JOIN admins ON admins.user_id = user.id ORDER BY email`).all()
    .map(r => ({ email: r.email, admin: !!r.admin, twoFactorEnabled: !!r.twoFactorEnabled, createdAt: r.createdAt, pending: !!r.pending, privateProfileCount: Number(r.privateProfileCount) }));
}

// Caller owns the transaction.
export function setAdmin(db: DatabaseSync, email: string, admin: boolean) {
  const id = userId(db, email);
  if (admin) db.prepare('INSERT INTO admins VALUES (?) ON CONFLICT DO NOTHING').run(id);
  else {
    keepGatewayAdmin(db, id);
    db.prepare('DELETE FROM admins WHERE user_id = ?').run(id);
  }
  return id;
}
