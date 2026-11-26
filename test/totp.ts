// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a setup key, for tests that sign in like an authenticator app.
import { createHmac } from 'node:crypto';

export function totp(setupKey: string, t = Date.now()) {
  const secret = setupKey.replace(/\s/g, '');
  let bits = '';
  for (const c of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** The setup key from a line the CLI prints, or undefined for any other line. */
export const setupKeyIn = (line: string) => line.match(/^Setup key: ([A-Z2-7 ]+)$/)?.[1];
