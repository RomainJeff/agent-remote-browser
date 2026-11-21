// Operator commands. Run them with the gateway stopped: they write arb.db and the login key.
//   node src/cli.ts rotate-login-key
//   node src/cli.ts migrate-from-poc <state.json> <poc-login.key> [--apply]
//   node src/cli.ts admin create <email>      (password, then TOTP code, on stdin)
//   node src/cli.ts admin reset-2fa <email>   (new password and new TOTP secret)
// Output: counts, key ids, profile ids and Docker resource names. Never a password, token or key, with one
// exception: `admin create` / `admin reset-2fa` print the TOTP otpauth:// URI once, to load in an authenticator app.
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadConfig, type Config } from './config.ts';
import { openDb, tx } from './store/db.ts';
import { openStore } from './store/store.ts';
import { decryptLogin, type Envelope } from './store/logins-crypto.ts';
import { COPY_IMAGE } from './host/docker.ts';
import { RunnerDriver } from './host/runner.ts';
import { pocVolume } from './runner/protocol.ts';
import { parseProfileId, cleanAllow, type ProfileId } from './policy.ts';
import { createAuth, authOptions } from './auth/better-auth.ts';

type Out = (line: string) => void;
type Copier = Pick<RunnerDriver, 'copyVolume'>;
/** Reads one line, without echo on a TTY. */
type Ask = (prompt: string) => Promise<string>;

const USAGE = 'Usage: node src/cli.ts rotate-login-key | migrate-from-poc <state.json> <poc-login.key> [--apply] | admin create|reset-2fa <email>';

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
    out(`Re-encrypted ${n} login(s): key ${from} -> ${store.keyId()}.`);
    out(`Previous key kept at ${old}: delete it once no backup of arb.db needs it.`);
  });
}

interface PocLogin { url: string; username: string; password: string | Envelope }
interface PocProfile { allow: unknown; logins?: Record<string, PocLogin>; createdAt?: unknown }

/** Imports POC profiles, allowlists and logins (re-encrypted, each one verified) in one transaction; dry run rolls back.
 *  Tokens and OAuth data stay behind: agents reconnect through OAuth or get an API key in the admin UI. */
async function migrateFromPoc(cfg: Config, stateFile: string, keyFile: string, apply: boolean, out: Out, docker?: Copier) {
  let state: { profiles?: Record<string, PocProfile> };
  // The parse error message can quote the file: keep it out of the output.
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { throw Error(`${stateFile} is not a readable JSON state file`); }
  const pocKey = readFileSync(keyFile);
  if (pocKey.length !== 32) throw Error('Invalid POC login key');
  const poc = Object.entries(state.profiles ?? {});

  const imported: ProfileId[] = [], skipped: string[] = [];
  let logins = 0, kid = '';
  const rollback = Symbol('dry run');
  withStore(cfg, (store, db) => {
    kid = store.keyId();
    try {
      tx(db, () => {
        for (const [raw, p] of poc) {
          const id = parseProfileId(raw), allow = cleanAllow(p.allow);
          if (!id) throw Error(`Invalid profile id in the POC state (${JSON.stringify(raw).slice(0, 50)})`);
          if (!allow) throw Error(`Invalid allow list for profile ${id}`);
          if (store.profile(id)) { skipped.push(id); continue; }
          store.createProfile(id, allow, typeof p.createdAt === 'number' ? p.createdAt : undefined);
          for (const [site, c] of Object.entries(p.logins ?? {})) {
            const password = typeof c.password === 'string' ? c.password : decryptLogin(pocKey, id, site, { ...c, password: c.password });
            store.saveLogin(id, site, c, password);
            if (store.decryptLogin(id, site, store.profile(id)!.logins[site]) !== password) throw Error(`Login ${id}/${site} does not decrypt`);
            logins++;
          }
          imported.push(id);
        }
        if (!apply) throw rollback;
      });
    } catch (e) { if (e !== rollback) throw e; }
  });

  const verb = apply ? 'Imported' : 'Would import';
  out(`${verb} ${imported.length} profile(s), ${logins} login(s), all verified with key ${kid}.`);
  if (imported.length) out(`Profiles: ${imported.join(', ')}`);
  if (skipped.length) out(`Already in arb.db, left untouched: ${skipped.join(', ')}`);
  out('Not imported: profile and global tokens, OAuth clients and tokens. Agents reconnect through OAuth or with an API key from the admin UI.');

  let failed = 0;
  for (const [raw] of poc) {
    const id = raw as ProfileId, from = pocVolume(id), to = `${cfg.prefix}-profile-${id}`;
    if (!apply) {
      out(`docker volume create --label ${cfg.prefix}-computer=${id} ${to}`);
      out(`docker run --rm --network none -v ${from}:/from:ro -v ${to}:/to ${COPY_IMAGE} cp -a /from/. /to/`);
      continue;
    }
    try { out(`${from} -> ${to}: ${await docker!.copyVolume(id)}`); }
    catch (e) { failed++; out(`${from} -> ${to}: failed (${(e as Error).message})`); }
  }
  if (!apply) out('Dry run: no profile imported, no volume touched. Re-run with --apply (gateway stopped) to import and copy the volumes.');
  return failed ? 1 : 0;
}

/** One admin (single-operator gateway). `create` makes it, `reset-2fa` sets a new password and TOTP secret.
 *  Both end with a verified TOTP code and no session left behind; backup codes are never printed. */
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
    out(`Admin ${email} ready: sign in with the password and a TOTP code.`);
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

/** Returns the exit code. `docker` replaces the runner client, `ask` the stdin reader (tests). */
export async function main(args: string[], env: NodeJS.ProcessEnv, out: Out, docker?: Copier, ask?: Ask): Promise<number> {
  const cfg = loadConfig(env);
  const [cmd, ...rest] = args;
  if (cmd === 'rotate-login-key' && rest.length === 0) { rotateLoginKey(cfg, out); return 0; }
  if (cmd === 'admin' && ['create', 'reset-2fa'].includes(rest[0]) && rest.length === 2) {
    await adminCmd(cfg, rest[0], rest[1], ask ?? stdinAsk(), out);
    return 0;
  }
  const files = rest.filter((a) => a !== '--apply');
  if (cmd === 'migrate-from-poc' && files.length === 2) {
    const apply = rest.includes('--apply');
    docker ??= new RunnerDriver(cfg.runnerSocket); // the runner does the copy: this process has no Docker socket
    return migrateFromPoc(cfg, files[0], files[1], apply, out, docker);
  }
  out(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (l) => console.log(l))
    .catch((e: Error) => { console.error(e.message); return 1; });
  process.stdin.unref?.(); // the admin prompt's reader must not keep the process alive
}
