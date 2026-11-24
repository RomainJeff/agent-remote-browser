// Operator commands. Run them with the gateway stopped (backup-db and key excepted): they write arb.db and the login key.
//   node src/cli.ts rotate-login-key
//   node src/cli.ts admin create <email>      (password, then TOTP code, on stdin)
//   node src/cli.ts admin reset-2fa <email>   (new password and new TOTP secret)
//   node src/cli.ts user create <email> [--admin]
//   node src/cli.ts user list | user remove <email> | user admin <email> on|off
//   node src/cli.ts backup-db <file>          (consistent snapshot of arb.db; safe while the gateway runs)
//   node src/cli.ts key create <profile>|--global <file> [days] [--as <email>]   (0600 file, default 1 day)
//   node src/cli.ts key revoke <id>
//   (both safe while the gateway runs: an operator, or an agent the operator lets run them, gets a test key
//    without the admin UI's password and TOTP. Docker access to the host already outranks that 2FA.)
// Enrollment prints the TOTP URI and backup codes once. Passwords and API keys are never printed.
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
import { createCredential, deleteSessions, listUsers, normalizedEmail, passwordHash, requireAvailable, setAdmin, startTotp, userId, verifyTotp } from './auth/accounts.ts';
import { parseProfileId } from './policy.ts';

type Out = (line: string) => void;
/** Reads one line, without echo on a TTY. */
type Ask = (prompt: string) => Promise<string>;

const USAGE = `Usage: node src/cli.ts <command>
  admin create|reset-2fa <email>
  user create <email> [--admin]
  user list
  user remove <email>
  user admin <email> on|off
  key create <profile>|--global <file> [days] [--as <email>]
  key revoke <id>
  rotate-login-key
  backup-db <file>`;

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

/** Create or recover a credential account, verify TOTP and print the new backup codes once. */
async function enroll(cfg: Config, email: string, mode: 'bootstrap' | 'admin' | 'member' | 'reset-2fa', ask: Ask, out: Out) {
  email = normalizedEmail(email);
  const db = openDb(join(cfg.dataDir, 'arb.db'));
  try {
    const { auth } = createAuth(db, authOptions(cfg));
    const creatingAdmin = mode === 'bootstrap' || mode === 'admin';
    const check = () => {
      requireAvailable(db, email);
      if (mode === 'bootstrap' && db.prepare('SELECT 1 FROM user').get()) throw Error('A user already exists: use user create');
      if (mode !== 'reset-2fa' && db.prepare('SELECT 1 FROM user WHERE email = ?').get(email)) throw Error(`${email} exists: use admin reset-2fa`);
      if (mode === 'reset-2fa') userId(db, email);
    };
    check();
    const password = await ask('Password (12+ characters): ');
    const hashed = await passwordHash(auth, password);
    const id = tx(db, () => {
      check();
      if (mode !== 'reset-2fa') return createCredential(db, email, hashed, creatingAdmin);
      const id = userId(db, email);
      db.prepare('DELETE FROM twoFactor WHERE userId = ?').run(id);
      db.prepare('UPDATE user SET twoFactorEnabled = 0 WHERE id = ?').run(id);
      db.prepare("UPDATE account SET password = ? WHERE userId = ? AND providerId = 'credential'").run(hashed, id);
      deleteSessions(db, id);
      return id;
    });
    const enrolled = await startTotp(auth, email, password);
    out('Add this to your authenticator app (shown once, do not share):');
    out(enrolled.totpURI);
    try { await verifyTotp(auth, enrolled.headers, (await ask('Code from the app: ')).trim()); }
    catch { throw Error(`Code rejected: run admin reset-2fa ${email}`); }
    finally { deleteSessions(db, id); }
    out('Backup codes, one use each (shown once, store them offline; reset-2fa makes new ones):');
    for (const c of enrolled.backupCodes) out(c);
    out(`${creatingAdmin ? 'Admin' : 'User'} ${email} ready: sign in with the password and a TOTP code.`);
  } finally { db.close(); }
}

function manageUsers(cfg: Config, args: string[], out: Out) {
  const db = openDb(join(cfg.dataDir, 'arb.db'));
  try {
    const [sub, email, setting] = args;
    if (sub === 'list') {
      for (const row of listUsers(db)) {
        out(`${row.email}\tadmin=${row.admin ? 'yes' : 'no'}\t2fa=${row.twoFactorEnabled ? 'yes' : 'no'}\tcreated=${row.createdAt}`);
      }
      return;
    }
    tx(db, () => {
      const id = setAdmin(db, email, setting === 'on');
      if (sub === 'remove') {
        db.prepare('DELETE FROM apikey WHERE referenceId = ?').run(id);
        db.prepare('DELETE FROM user WHERE id = ?').run(id);
      }
    });
  } finally { db.close(); }
}

/** Same key as the admin UI's (scope profile:<id>, or global with --global), written to a new 0600 file
 *  instead of being shown: the CLI never prints a key. Days: 1 to 365, default 1 (a test key should not outlive the test). */
async function keyCmd(cfg: Config, args: string[], out: Out, as?: string) {
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
    db.exec('BEGIN IMMEDIATE'); // Serialize key creation with user removal (apikey.referenceId has no foreign key).
    const owner = as === undefined
      ? db.prepare('SELECT user_id FROM admins JOIN user ON user.id = admins.user_id WHERE email NOT IN pending_emails ORDER BY admins.rowid LIMIT 1').get()?.user_id as string | undefined
      : userId(db, as);
    if (!owner) throw Error('No gateway admin: specify --as <email> or create an admin');
    const { auth } = createAuth(db, authOptions(cfg));
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); // never overwrite: claim the file before the key exists
    let k;
    try {
      k = await auth.api.createApiKey({ body: { name: `cli ${id ?? 'global'}`, userId: owner, metadata: { scope: id ? `profile:${id}` : 'global' }, expiresIn: days * 86400 } });
      writeFileSync(file, k.key);
      db.exec('COMMIT');
    } catch (e) { rmSync(file, { force: true }); throw e; }
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
    await enroll(cfg, rest[1], rest[0] === 'create' ? 'bootstrap' : 'reset-2fa', ask ?? stdinAsk(), out);
    return 0;
  }
  if (cmd === 'user') {
    const [sub, email, flag] = rest;
    if (sub === 'create' && (rest.length === 2 || (rest.length === 3 && flag === '--admin'))) {
      await enroll(cfg, email, flag ? 'admin' : 'member', ask ?? stdinAsk(), out);
      return 0;
    }
    if ((sub === 'list' && rest.length === 1) || (sub === 'remove' && rest.length === 2) ||
        (sub === 'admin' && rest.length === 3 && ['on', 'off'].includes(flag))) {
      manageUsers(cfg, rest, out);
      return 0;
    }
  }
  if (cmd === 'key' && rest[0] === 'create' && [5, 6].includes(rest.length) && rest.at(-2) === '--as') {
    await keyCmd(cfg, rest.slice(0, -2), out, rest.at(-1));
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
