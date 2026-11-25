// Self-service password reset: email + current authenticator code + new password, then a normal sign-in.
// TOTP only: losing both the password and the authenticator still goes through the host CLI (admin reset-2fa).
// Better Auth only checks a TOTP inside a session or after the password step, so the code is checked here with the
// same primitives (symmetricDecrypt, createOTP). Failures feed Better Auth's per-account lockout columns, so sign-in
// and reset together allow no more guesses than sign-in alone.
import type { DatabaseSync } from 'node:sqlite';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { tx } from '../store/db.ts';
import { AccountError, deleteSessions, normalizedEmail, passwordHash } from './accounts.ts';
import { LOCKOUT, type Auth } from './better-auth.ts';

type Row = { id: string; userId: string; secret: string; lockedUntil: string | null };

/** Returns the email on success. Behind Cloudflare Access, `accessEmail` must be the account's own. */
export async function resetPassword(db: DatabaseSync, auth: Auth, body: Record<string, unknown>, accessEmail?: string) {
  const email = normalizedEmail(body.email), invalid = new AccountError(401, 'Invalid email or code');
  if (accessEmail !== undefined && email !== accessEmail) throw new AccountError(403, 'forbidden');
  const hashed = await passwordHash(auth, body.password);
  // Same eligibility as sign-in: 2FA enabled and its secret confirmed (an unfinished invite has neither).
  const row = db.prepare(`SELECT twoFactor.id, userId, secret, lockedUntil FROM twoFactor JOIN user ON user.id = userId
    WHERE email = ? AND twoFactorEnabled = 1 AND coalesce(verified, 1) = 1`).get(email) as Row | undefined;
  if (!row || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw invalid;
  if (row.lockedUntil && Date.parse(row.lockedUntil) > Date.now()) throw new AccountError(429, 'Too many attempts, try again later');
  const secret = await symmetricDecrypt({ key: (await auth.$context).secretConfig, data: row.secret });
  if (!await createOTP(secret, { digits: 6, period: 30 }).verify(body.code)) {
    // An expired lock restarts the count, as in Better Auth's assertTwoFactorNotLocked.
    db.prepare(`UPDATE twoFactor SET
      failedVerificationCount = CASE WHEN lockedUntil IS NULL THEN coalesce(failedVerificationCount, 0) ELSE 0 END + 1,
      lockedUntil = CASE WHEN (CASE WHEN lockedUntil IS NULL THEN coalesce(failedVerificationCount, 0) ELSE 0 END) + 1 >= ? THEN ? END
      WHERE id = ?`).run(LOCKOUT.maxFailedAttempts, new Date(Date.now() + LOCKOUT.durationSeconds * 1000).toISOString(), row.id);
    throw invalid;
  }
  tx(db, () => {
    db.prepare("UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'").run(hashed, new Date().toISOString(), row.userId);
    db.prepare('UPDATE twoFactor SET failedVerificationCount = 0, lockedUntil = NULL WHERE id = ?').run(row.id);
    deleteSessions(db, row.userId);
  });
  return email;
}
