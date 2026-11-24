import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hash } from '../policy.ts';
import { tx } from '../store/db.ts';
import { AccountError, createCredential, deleteSessions, passwordHash, startTotp, verifyTotp } from './accounts.ts';
import type { Auth } from './better-auth.ts';

type Invite = { id: string; email: string; admin: number };
const missing = () => new AccountError(404, 'Invite unavailable');

export function openInvites(db: DatabaseSync) {
  return db.prepare(`SELECT invites.id, invites.email, admin, created, expires, user.email AS createdBy
    FROM invites LEFT JOIN user ON user.id = created_by WHERE used IS NULL AND expires > ? ORDER BY created`)
    .all(Date.now()).map(r => ({ ...r, admin: !!r.admin }));
}

function removePending(db: DatabaseSync, invite: Invite) {
  db.prepare('DELETE FROM user WHERE email = ?').run(invite.email);
  db.prepare('DELETE FROM invites WHERE id = ?').run(invite.id);
}

export function revoke(db: DatabaseSync, id: string) {
  return tx(db, () => {
    const invite = db.prepare('SELECT * FROM invites WHERE id = ? AND used IS NULL').get(id) as Invite | undefined;
    if (!invite) throw missing();
    removePending(db, invite);
    return invite.email;
  });
}

export function issue(db: DatabaseSync, email: string, admin: boolean, creator: string, base: string) {
  return tx(db, () => {
    const now = Date.now(), prior = db.prepare('SELECT * FROM invites WHERE email = ? AND used IS NULL').get(email);
    if (prior && Number(prior.expires) > now) throw new AccountError(409, 'An open invite already exists');
    if (prior) removePending(db, prior as Invite);
    else if (db.prepare('SELECT 1 FROM user WHERE email = ?').get(email)) throw new AccountError(409, 'Account already exists');
    if (db.prepare('SELECT 1 FROM invites WHERE used IS NULL AND expires > ? LIMIT 1 OFFSET 9').get(now))
      throw new AccountError(409, 'At most 10 invites may be open');
    const token = 'arb_i_' + randomBytes(24).toString('base64url'), id = randomUUID(), expires = now + 86400_000;
    db.prepare('INSERT INTO invites (id, token_hash, email, admin, created_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, hash(token), email, Number(admin), creator, now, expires);
    return { id, link: base + '/#/invite/' + token, expiresAt: expires };
  });
}

function usable(db: DatabaseSync, token: unknown, accessEmail?: string) {
  const invite = typeof token === 'string' && db.prepare('SELECT * FROM invites WHERE token_hash = ? AND expires > ? AND used IS NULL')
    .get(hash(token), Date.now()) as Invite | undefined;
  if (!invite) throw missing();
  if (accessEmail !== undefined && invite.email !== accessEmail) throw new AccountError(403, 'forbidden');
  return invite;
}

export async function startInvite(db: DatabaseSync, auth: Auth, token: unknown, password: string, accessEmail?: string) {
  const invite = usable(db, token, accessEmail);
  const hashed = await passwordHash(auth, password);
  tx(db, () => {
    usable(db, token, accessEmail);
    db.prepare('DELETE FROM user WHERE email = ?').run(invite.email);
    createCredential(db, invite.email, hashed, false);
  });
  return startTotp(auth, invite.email, password);
}

export async function finishInvite(db: DatabaseSync, auth: Auth, headers: Headers, token: unknown, code: unknown, accessEmail?: string) {
  const invite = usable(db, token, accessEmail);
  const session = await auth.api.getSession({ headers });
  if (!session || session.user.email !== invite.email) throw new AccountError(401, 'Start enrollment first');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new AccountError(400, 'Invalid code');
  const verified = await verifyTotp(auth, headers, code).catch(() => null);
  if (verified?.user.id !== session.user.id) throw new AccountError(401, 'Invalid code');
  const id = session.user.id;
  const { backupCodes } = await auth.api.viewBackupCodes({ body: { userId: id } });
  tx(db, () => {
    usable(db, token, accessEmail);
    if (!db.prepare('SELECT 1 FROM user WHERE id = ? AND email = ?').get(id, invite.email)) throw missing();
    db.prepare('UPDATE invites SET used = ? WHERE id = ?').run(Date.now(), invite.id);
    if (invite.admin) db.prepare('INSERT INTO admins VALUES (?)').run(id);
    deleteSessions(db, id);
  });
  return { backupCodes };
}
