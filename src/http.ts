// Two helpers shared by the MCP and admin listeners.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** JSON body, 1 MB max. Undefined when empty. */
export function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export const send = (res: ServerResponse, code: number, obj: unknown, headers?: Record<string, string>) =>
  res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));
