// The host contract: everything the gateway may ask of the machine that runs the browsers.
// A driver never receives a container spec, only a ProfileId: it builds the (fixed) spec itself.
import type { Duplex } from 'node:stream';
import type { ProfileId } from '../policy.ts';

export interface Computer { id: string; running: boolean; startedAt?: number }
export interface ExecResult { code: number; stdout: string; stderr: string }

export interface HostDriver {
  /** Idempotent: creates, recreates (wrong spec) or starts the computer as needed. */
  ensure(id: ProfileId, opts: { egressDir: string }): Promise<Computer>
  exec(id: ProfileId, argv: string[], opts: { stdin?: string; timeoutMs: number }): Promise<ExecResult>
  /** Raw byte relay to a loopback port inside the computer: write the port and "\n" first, then the bytes. */
  stream(id: ProfileId): Promise<Duplex>
  stop(id: ProfileId): Promise<void>
  remove(id: ProfileId, opts: { keepVolume: boolean }): Promise<void>
  /** Computers of this stack only (prefix label), running or not. */
  list(): Promise<Computer[]>
}

/** Runs inside the computer for stream(): first stdin line = loopback port, the rest is piped both ways. */
export const relay = `let b=Buffer.alloc(0);const f=d=>{b=Buffer.concat([b,d]);const i=b.indexOf(10);if(i<0)return;
process.stdin.off('data',f);const s=require('net').connect(+b.subarray(0,i),'127.0.0.1');s.write(b.subarray(i+1));
process.stdin.pipe(s).pipe(process.stdout);s.on('close',()=>process.exit());s.on('error',()=>process.exit(1))};
process.stdin.on('data',f);`;
