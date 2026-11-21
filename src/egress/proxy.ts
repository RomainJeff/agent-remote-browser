// The browser has no Docker network. Its loopback HTTP proxy forwards to this Unix socket.
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { urlAllowed } from '../policy.ts';
import { count } from '../metrics.ts';

export interface Proxy {
  /** Pin every request to one origin (login), or lift the pin. Drops open connections either way. */
  restrict(origin?: string): void
  close(): void
}

export function publicIPv4(address: string) {
  if (!net.isIPv4(address)) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !([0,10,127].includes(a) || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && [0,2].includes(c)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

export async function startProxy(dir: string, getAllow: () => readonly string[]): Promise<Proxy> {
  let origin: string | undefined, epoch = 0;
  const sockets = new Set<net.Socket>();
  async function target(url: URL) {
    const generation = epoch;
    if (!urlAllowed(url.href, getAllow()) || url.port || (origin && origin !== url.origin)) throw Error();
    const {address} = await lookup(url.hostname, {family:4});
    if (!publicIPv4(address) || epoch !== generation) throw Error();
    return address;
  }
  const server = http.createServer(async (req,res) => {
    try {
      const u = new URL(req.url!);
      if (u.protocol !== 'http:') throw Error();
      const address = await target(u);
      if (req.socket.destroyed) return;
      const headers = {...req.headers, host:u.host, connection:'close'};
      delete headers['proxy-authorization'];
      const out = http.request({host:address, port:80, path:u.pathname+u.search, method:req.method, headers, agent:false}, upstream=>{
        res.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(res);
      });
      res.on('close',()=>out.destroy());
      out.on('error',()=>res.destroy());
      req.pipe(out);
    } catch { count('arb_egress_denied_total'); res.writeHead(403).end(); }
  });
  server.maxConnections = 128;
  server.on('connection', (s: net.Socket)=>{ s.on('error',()=>s.destroy()); sockets.add(s); s.on('close',()=>sockets.delete(s)); });
  server.on('connect', async (req: http.IncomingMessage, s: net.Socket, head: Buffer)=>{
    try {
      if (!/^[a-z0-9.-]+:443$/i.test(req.url!)) throw Error();
      const address = await target(new URL('https://'+req.url));
      if (s.destroyed) return;
      const remote = net.connect(443,address,()=>{
        s.write('HTTP/1.1 200 Connection Established\r\n\r\n'); remote.write(head);
        remote.pipe(s).pipe(remote);
      });
      remote.on('error',()=>s.destroy()); s.on('error',()=>remote.destroy());
      s.on('close',()=>remote.destroy()); remote.on('close',()=>s.destroy());
    } catch { count('arb_egress_denied_total'); s.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  mkdirSync(dir,{recursive:true});
  const path = dir+'/proxy.sock';
  rmSync(path,{force:true});
  await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(path,resolve));
  chmodSync(path,0o666);
  function restrict(value?: string) {
    origin=value; epoch++; for (const s of sockets) s.destroy();
  }
  return {restrict, close(){ restrict(); server.close(); }};
}
