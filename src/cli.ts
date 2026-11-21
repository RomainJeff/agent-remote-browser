// Operator commands. Run them with the gateway stopped: they write arb.db and the login key.
//   node src/cli.ts rotate-login-key
//   node src/cli.ts migrate-from-poc <state.json> <poc-login.key> [--apply]
// Output: counts, key ids, profile ids and Docker resource names. Never a password, token or key.
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, type Config } from './config.ts';
import { openDb, tx } from './store/db.ts';
import { openStore } from './store/store.ts';
import { decryptLogin, type Envelope } from './store/logins-crypto.ts';
import { DockerDriver, COPY_IMAGE } from './host/docker.ts';
import { parseProfileId, cleanAllow, type ProfileId } from './policy.ts';

type Out = (line: string) => void;
type Copier = Pick<DockerDriver, 'copyVolume'>;

/** Volume prefix of the POC (agent-computer). */
const POC_PREFIX = 'ac';
const USAGE = 'Usage: node src/cli.ts rotate-login-key | migrate-from-poc <state.json> <poc-login.key> [--apply]';

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
 *  Tokens and OAuth data stay behind: profiles get a new token in the admin UI, agents reconnect. */
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
          store.createProfile(id, allow, null, typeof p.createdAt === 'number' ? p.createdAt : undefined);
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
  out('Not imported: profile and global tokens, OAuth clients and tokens. Generate new tokens in the admin UI; agents reconnect.');

  let failed = 0;
  for (const [raw] of poc) {
    const id = raw as ProfileId, from = `${POC_PREFIX}-profile-${id}`, to = `${cfg.prefix}-profile-${id}`;
    if (!apply) {
      out(`docker volume create --label ${cfg.prefix}-computer=${id} ${to}`);
      out(`docker run --rm --network none -v ${from}:/from:ro -v ${to}:/to ${COPY_IMAGE} cp -a /from/. /to/`);
      continue;
    }
    try { out(`${from} -> ${to}: ${await docker!.copyVolume(from, id)}`); }
    catch (e) { failed++; out(`${from} -> ${to}: failed (${(e as Error).message})`); }
  }
  if (!apply) out('Dry run: no profile imported, no volume touched. Re-run with --apply (gateway stopped) to import and copy the volumes.');
  return failed ? 1 : 0;
}

/** Returns the exit code. `docker` replaces the Docker Engine client (tests). */
export async function main(args: string[], env: NodeJS.ProcessEnv, out: Out, docker?: Copier): Promise<number> {
  const cfg = loadConfig(env);
  const [cmd, ...rest] = args;
  if (cmd === 'rotate-login-key' && rest.length === 0) { rotateLoginKey(cfg, out); return 0; }
  const files = rest.filter((a) => a !== '--apply');
  if (cmd === 'migrate-from-poc' && files.length === 2) {
    const apply = rest.includes('--apply');
    docker ??= new DockerDriver({ socket: cfg.dockerSocket, prefix: cfg.prefix, image: cfg.image, runtime: cfg.runtime });
    return migrateFromPoc(cfg, files[0], files[1], apply, out, docker);
  }
  out(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (l) => console.log(l))
    .catch((e: Error) => { console.error(e.message); return 1; });
}
