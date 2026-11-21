// Saved login envelopes: AES-256-GCM, the password bound to its profile, site, URL and username (AAD).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export interface Envelope { iv: string; tag: string; data: string }
export interface LoginRef { url: string; username: string }

/** Reads the 32-byte key, creating it (0600, never overwriting) only when no envelope needs an older one. */
export function loadLoginKey(file: string, hasEnvelopes: boolean): Buffer {
  if (!existsSync(file)) {
    if (hasEnvelopes) throw Error('Restore the existing login key');
    writeFileSync(file, randomBytes(32), {flag:'wx', mode:0o600});
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw Error('Invalid login key');
  return key;
}

const aad = (id: string, site: string, c: LoginRef) => Buffer.from(JSON.stringify([id,site,c.url,c.username]));

export function encryptLogin(key: Buffer, id: string, site: string, c: LoginRef, password: string): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(aad(id,site,c));
  const data = Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);
  return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}

export function decryptLogin(key: Buffer, id: string, site: string, c: LoginRef & { password: Envelope }) {
  const {iv,tag,data} = c.password;
  const cipher = createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
  cipher.setAAD(aad(id,site,c));
  cipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
}
