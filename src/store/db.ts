// SQLite through node:sqlite (built into Node, no native dependency). One file: ${DATA_DIR}/arb.db.
// Better Auth shares this database (its Kysely adapter takes the DatabaseSync instance); its tables come from migrations.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const dir = new URL('./migrations/', import.meta.url).pathname;

/** Migrations: migrations/NNN_name.sql, applied in order, one transaction each. PRAGMA user_version = last applied NNN.
 *  Foreign keys are off while they run (SQLite's table rebuild procedure) and checked before each commit. */
export function migrate(db: DatabaseSync) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const f of readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()) {
      const v = Number(f.slice(0, 3));
      if (v <= current) continue;
      tx(db, () => {
        db.exec(readFileSync(dir + f, 'utf8'));
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error(`Migration ${f} breaks a foreign key`);
        db.exec(`PRAGMA user_version = ${v}`);
      });
    }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

/** Runs fn in one write transaction: all or nothing. ponytail: not reentrant, callers never nest. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function openDb(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  closeSync(openSync(file, 'a', 0o600));
  chmodSync(file, 0o600); // SQLite gives the -wal and -shm files the mode of the database file
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}
