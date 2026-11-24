// Envelopes: AES-256-GCM. A saved login's password is bound to its profile, site, URL and username (AAD);
// a profile header's value to its profile, origin and name.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export interface Envelope { iv: string; tag: string; data: string }
export interface LoginRef { url: string; username: string }

/** Reads the 32-byte key, creating it (0600, never overwriting) only when no envelope needs an older one.
 *  A Docker secret is read-only: there the operator creates the file (see docs/reference.md, "Login key"). */
export function loadLoginKey(file: string, hasEnvelopes: boolean): Buffer {
  if (!existsSync(file)) {
    if (hasEnvelopes) throw Error(`Restore the existing login key at ${file}`);
    try { writeFileSync(file, randomBytes(32), {flag:'wx', mode:0o600}); }
    catch { throw Error(`No login key at ${file} and it cannot be created there: write 32 random bytes to it`); }
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw Error('Invalid login key');
  return key;
}

/** Public id of a key, stored next to each envelope: tells which key a login needs without trying it. */
export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

const aad = (id: string, site: string, c: LoginRef) => [id, site, c.url, c.username];

/** AES-256-GCM, the plaintext bound to `aad` (JSON): a sealed value cannot be moved to another row. */
export function seal(key: Buffer, aad: unknown, plain: string): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const data = Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);
  return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}

export function unseal(key: Buffer, aad: unknown, {iv,tag,data}: Envelope) {
  const cipher = createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  cipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
}

export const encryptLogin = (key: Buffer, id: string, site: string, c: LoginRef, password: string) => seal(key, aad(id,site,c), password);
export const decryptLogin = (key: Buffer, id: string, site: string, c: LoginRef & { password: Envelope }) => unseal(key, aad(id,site,c), c.password);
