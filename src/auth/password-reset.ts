// Password reset link: a gateway admin issues it, the member picks a new password and keeps their 2FA.
// Better Auth's own reset-password flow, with the link handed over by the admin instead of emailed: the row below is the
// one its requestPasswordReset would create, and its resetPassword endpoint (server-side only, never in AUTH_API)
// checks, consumes it, sets the password and signs the account out everywhere (revokeSessionsOnPasswordReset).
// Lost authenticator: `admin reset-2fa` on the host, unchanged.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { APIError } from 'better-auth/api';
import { AccountError, userId } from './accounts.ts';
import type { Auth } from './better-auth.ts';

const PREFIX = 'reset-password:';
const missing = () => new AccountError(404, 'Link unavailable');

/** A new link replaces this member's earlier ones. Valid 24 h, like invites. */
export async function issueReset(db: DatabaseSync, auth: Auth, email: string, base: string) {
  const id = userId(db, email), token = randomBytes(24).toString('base64url'), expiresAt = Date.now() + 86400_000;
  const { internalAdapter } = await auth.$context;
  db.prepare('DELETE FROM verification WHERE identifier LIKE ? AND value = ?').run(PREFIX + '%', id);
  await internalAdapter.createVerificationValue({ identifier: PREFIX + token, value: id, expiresAt: new Date(expiresAt) });
  return { link: base + '/#/reset-password/' + token, expiresAt };
}

/** Behind Cloudflare Access, `accessEmail` must be the account's own (same rule as invites). Returns the email. */
export async function finishReset(auth: Auth, token: unknown, password: unknown, accessEmail?: string) {
  if (typeof token !== 'string' || !token) throw missing();
  const { internalAdapter } = await auth.$context;
  const row = await internalAdapter.findVerificationValue(PREFIX + token);
  const user = row && row.expiresAt > new Date() ? await internalAdapter.findUserById(row.value) : null;
  if (!user) throw missing();
  if (accessEmail !== undefined && user.email !== accessEmail) throw new AccountError(403, 'forbidden');
  if (typeof password !== 'string') throw new AccountError(400, 'Password: 12 to 128 characters');
  await auth.api.resetPassword({ body: { token, newPassword: password } }).catch((e) => {
    if (!(e instanceof APIError)) throw e;
    throw /^PASSWORD_TOO_(SHORT|LONG)$/.test(e.body?.code ?? '') ? new AccountError(400, 'Password: 12 to 128 characters') : missing();
  });
  return user.email;
}
