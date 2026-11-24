import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Auth } from './better-auth.ts';

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

export function listUsers(db: DatabaseSync) {
  return db.prepare(`SELECT email, admins.user_id IS NOT NULL AS admin, twoFactorEnabled, createdAt,
    email IN pending_emails AS pending FROM user LEFT JOIN admins ON admins.user_id = user.id ORDER BY email`).all()
    .map(r => ({ email: r.email, admin: !!r.admin, twoFactorEnabled: !!r.twoFactorEnabled, createdAt: r.createdAt, pending: !!r.pending }));
}

// Called inside the same transaction as user removal, when applicable.
export function setAdmin(db: DatabaseSync, email: string, admin: boolean) {
  const id = userId(db, email);
  if (admin) db.prepare('INSERT INTO admins VALUES (?) ON CONFLICT DO NOTHING').run(id);
  else if (db.prepare('DELETE FROM admins WHERE user_id = ?').run(id).changes &&
    !db.prepare('SELECT 1 FROM admins JOIN user ON user.id = admins.user_id WHERE email NOT IN pending_emails').get())
    throw new AccountError(409, 'Cannot remove the last gateway admin');
  return id;
}
