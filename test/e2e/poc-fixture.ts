// Synthetic POC state for the CI migration drill: <dir>/state.json + <dir>/login.key, one profile "legacy" with one
// saved login encrypted the way the POC did. Generated on the spot, never a real POC file.
//   node test/e2e/poc-fixture.ts "$RUNNER_TEMP/poc"
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptLogin } from '../../src/store/logins-crypto.ts';

const dir = process.argv[2], key = randomBytes(32), login = { url: 'https://example.com/login', username: 'fixture' };
mkdirSync(dir, { recursive: true });
// 0644: the one-off gateway container (uid 1000) reads them through a read-only bind mount.
writeFileSync(join(dir, 'login.key'), key, { mode: 0o644 });
writeFileSync(join(dir, 'state.json'), JSON.stringify({ profiles: { legacy: { allow: ['example.com'], createdAt: Date.now(),
  logins: { main: { ...login, password: encryptLogin(key, 'legacy', 'main', login, randomBytes(12).toString('hex')) } } } } }), { mode: 0o644 });
