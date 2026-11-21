// Runs inside each computer as its main process (`node -e bridge`): the browser has no network, its
// loopback HTTP proxy (127.0.0.1:3128) is piped to the gateway's per-profile proxy socket.
// First it drops Chrome's profile lock: a container removed without a clean close leaves a lock naming its old
// hostname, and Chrome then refuses the profile ("in use on another computer") and crash-loops. One container per
// volume, so a lock at start is always stale.
import { PROFILE } from '../runner/protocol.ts';

export const bridge = `const fs=require('node:fs');
for(const f of ['SingletonLock','SingletonCookie','SingletonSocket'])try{fs.rmSync('${PROFILE}/'+f,{force:true})}catch{}
const net=require('node:net');
net.createServer(a=>{const b=net.connect('/egress/proxy.sock');
a.on('error',()=>b.destroy()); b.on('error',()=>a.destroy());
a.on('close',()=>b.destroy()); b.on('close',()=>a.destroy()); a.pipe(b).pipe(a);
}).listen(3128,'127.0.0.1');`;
