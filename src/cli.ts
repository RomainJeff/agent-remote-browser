// Operator commands. Run them with the gateway stopped (backup-db and key excepted): they write arb.db and the login key.
//   node src/cli.ts rotate-login-key
//   node src/cli.ts admin create <email>      (password, then TOTP code, on stdin)
//   node src/cli.ts admin reset-2fa <email>   (new password and new TOTP secret)
//   node src/cli.ts backup-db <file>          (consistent snapshot of arb.db; safe while the gateway runs)
//   node src/cli.ts key create <profile>|--global <file> [days]   (API key written to <file>, 0600; default 1 day)
//   node src/cli.ts key revoke <id>
//   (both safe while the gateway runs: an operator, or an agent the operator lets run them, gets a test key
//    without the admin UI's password and TOTP. Docker access to the host already outranks that 2FA.)
// Output: counts, key ids, profile ids and Docker resource names. Never a password, token or key, with one
// exception: `admin create` / `admin reset-2fa` print the TOTP otpauth:// URI once, to load in an authenticator app.
import { writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadConfig, type Config } from './config.ts';
import { DatabaseSync } from 'node:sqlite';
import { openDb, tx } from './store/db.ts';
import { openStore } from './store/store.ts';
import { createAuth, authOptions } from './auth/better-auth.ts';
import { parseProfileId } from './policy.ts';

type Out = (line: string) => void;
/** Reads one line, without echo on a TTY. */
type Ask = (prompt: string) => Promise<string>;

const USAGE = 'Usage: node src/cli.ts rotate-login-key | admin create|reset-2fa <email> | backup-db <file> | key create <profile>|--global <file> [days] | key revoke <id>';

function withStore<T>(cfg: Config, fn: (store: ReturnType<typeof openStore>, db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(join(cfg.dataDir, 'arb.db'));
  try { return fn(openStore(db, cfg.loginKeyFile), db); } finally { db.close(); }
}

/** New key in <key>.new, every login re-encrypted in one transaction, then <key> -> <key>.old and <key>.new -> <key>. */
function rotateLoginKey(cfg: Config, out: Out) {
  const file = cfg.loginKeyFile, next = file + '.new', old = file + '.old';
  for (const f of [next, old]) if (existsSync(f)) throw Error(`${f} exists (earlier rotation?): move it away first`);
  withStore(cfg, (store) => {
    const from = store.keyId(), key = randomBytes(32);
    writeFileSync(next, key, { flag: 'wx', mode: 0o600 });
    let n: number;
    try { n = store.rotateLoginKey(key); } catch (e) { rmSync(next); throw e; }
    // ponytail: a crash between commit and these renames leaves the live key in <key>.new; boot then names the key id it needs.
    renameSync(file, old);
    renameSync(next, file);
    out(`Re-encrypted ${n} login(s) and header(s): key ${from} -> ${store.keyId()}.`);
    out(`Previous key kept at ${old}: delete it once no backup of arb.db needs it.`);
  });
}

/** VACUUM INTO: one read transaction, so the copy is consistent even with the gateway writing (copying arb.db
 *  and its -wal by hand is not). The copy is a plain DB (no -wal), 0600, checked before reporting success. */
function backupDb(cfg: Config, file: string, out: Out) {
  withStore(cfg, (_store, db) => {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); // never overwrite; SQLite keeps the mode of an existing file
    try {
      db.prepare('VACUUM INTO ?').run(file);
      const copy = new DatabaseSync(file, { readOnly: true });
      try {
        const ok = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
        if (ok !== 'ok') throw Error('integrity check of the copy failed');
        const n = (t: string) => (copy.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
        out(`arb.db backed up to ${file}: ${n('profiles')} profile(s), ${n('logins')} login(s), integrity ok.`);
      } finally { copy.close(); }
    } catch (e) { rmSync(file, { force: true }); throw e; }
  });
}

/** One admin (single-operator gateway). `create` makes it, `reset-2fa` sets a new password and TOTP secret.
 *  Both end with a verified TOTP code, 10 fresh one-time backup codes printed once, and no session left behind. */
async function adminCmd(cfg: Config, sub: string, email: string, ask: Ask, out: Out) {
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw Error('Invalid email');
  email = email.toLowerCase();
  const db = openDb(join(cfg.dataDir, 'arb.db'));
  try {
    const { auth } = createAuth(db, authOptions(cfg));
    const ctx = await auth.$context;
    let user = await ctx.internalAdapter.findUserByEmail(email).then((r) => r?.user ?? null);
    if (sub === 'create' && user) throw Error(`${email} exists: use admin reset-2fa`);
    if (sub === 'create' && db.prepare('SELECT 1 FROM user').get()) throw Error('An admin already exists: one admin per gateway');
    if (sub === 'reset-2fa' && !user) throw Error(`No admin ${email}`);
    const password = await ask('Password (12+ characters): ');
    if (password.length < 12 || password.length > 128) throw Error('Password: 12 to 128 characters');
    const hashed = await ctx.password.hash(password);
    if (!user) {
      user = await ctx.internalAdapter.createUser({ email, name: 'Admin', emailVerified: true }, { method: 'admin' });
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hashed });
    } else {
      const id = user.id;
      tx(db, () => {
        db.prepare('DELETE FROM twoFactor WHERE userId = ?').run(id);
        db.prepare('UPDATE user SET twoFactorEnabled = 0 WHERE id = ?').run(id);
        db.prepare("UPDATE account SET password = ? WHERE userId = ? AND providerId = 'credential'").run(hashed, id);
        db.prepare('DELETE FROM session WHERE userId = ?').run(id);
      });
    }
    // Enroll through Better Auth itself (it encrypts the TOTP secret with BETTER_AUTH_SECRET).
    const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const headers = new Headers({ cookie: signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });
    const enrolled = await auth.api.enableTwoFactor({ body: { password }, headers });
    if (!('totpURI' in enrolled)) throw Error('TOTP enrollment failed');
    out('Add this to your authenticator app (shown once, do not share):');
    out(enrolled.totpURI);
    try { await auth.api.verifyTOTP({ body: { code: (await ask('Code from the app: ')).trim() }, headers }); }
    catch { throw Error(`Code rejected: run admin reset-2fa ${email}`); }
    finally { db.prepare('DELETE FROM session WHERE userId = ?').run(user.id); }
    out('Backup codes, one use each (shown once, store them offline; reset-2fa makes new ones):');
    for (const c of enrolled.backupCodes) out(c);
    out(`Admin ${email} ready: sign in with the password and a TOTP code.`);
  } finally { db.close(); }
}

/** Same key as the admin UI's (scope profile:<id>, or global with --global), owned by the admin, but written to a new 0600 file
 *  instead of being shown: the CLI never prints a key. Days: 1 to 365, default 1 (a test key should not outlive the test). */
async function keyCmd(cfg: Config, args: string[], out: Out) {
  const db = openDb(join(cfg.dataDir, 'arb.db'));
  try {
    if (args[0] === 'revoke') {
      if (!db.prepare('DELETE FROM apikey WHERE id = ?').run(args[1]).changes) throw Error(`No key ${args[1]}`);
      out(`Key ${args[1]} revoked.`);
      return;
    }
    const [, raw, file, d = '1'] = args, days = Number(d), global = raw === '--global', id = global ? null : parseProfileId(raw);
    if (!global && !(id && openStore(db, cfg.loginKeyFile).profile(id))) throw Error(`No profile ${raw}`);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw Error('Days: 1 to 365');
    const admin = db.prepare('SELECT id FROM user').get() as { id: string } | undefined;
    if (!admin) throw Error('No admin yet: run admin create first');
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); // never overwrite: claim the file before the key exists
    const { auth } = createAuth(db, authOptions(cfg));
    const k = await auth.api.createApiKey({ body: { name: `cli ${id ?? 'global'}`, userId: admin.id, metadata: { scope: id ? `profile:${id}` : 'global' }, expiresIn: days * 86400 } })
      .catch((e) => { rmSync(file); throw e; });
    writeFileSync(file, k.key);
    out(`Key ${k.id} for ${id ? `profile ${id}` : 'all profiles (global)'}, expires ${new Date(k.expiresAt!).toISOString()}, written to ${file}. Revoke: key revoke ${k.id}`);
  } finally { db.close(); }
}

function stdinAsk(): Ask {
  // Muted output: neither the password nor the code is echoed. Prompts go to stderr.
  const rl = createInterface({ input: process.stdin, output: new Writable({ write: (_c, _e, cb) => cb() }), terminal: !!process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  return async (prompt) => {
    process.stderr.write(prompt);
    const r = await lines.next();
    if (process.stdin.isTTY) process.stderr.write('\n');
    if (r.done) throw Error('stdin closed');
    return r.value;
  };
}

/** Returns the exit code. `ask` replaces the stdin reader (tests). */
export async function main(args: string[], env: NodeJS.ProcessEnv, out: Out, ask?: Ask): Promise<number> {
  const cfg = loadConfig(env);
  const [cmd, ...rest] = args;
  if (cmd === 'rotate-login-key' && rest.length === 0) { rotateLoginKey(cfg, out); return 0; }
  if (cmd === 'backup-db' && rest.length === 1) { backupDb(cfg, rest[0], out); return 0; }
  if (cmd === 'admin' && ['create', 'reset-2fa'].includes(rest[0]) && rest.length === 2) {
    await adminCmd(cfg, rest[0], rest[1], ask ?? stdinAsk(), out);
    return 0;
  }
  if (cmd === 'key' && ((rest[0] === 'create' && [3, 4].includes(rest.length)) || (rest[0] === 'revoke' && rest.length === 2))) {
    await keyCmd(cfg, rest, out);
    return 0;
  }
  out(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (l) => console.log(l))
    .catch((e: Error) => { console.error(e.message); return 1; });
  process.stdin.unref?.(); // the admin prompt's reader must not keep the process alive
}
