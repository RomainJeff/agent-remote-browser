// Runs inside each computer as its main process (`node -e bridge`): the browser has no network, its
// loopback HTTP proxy (127.0.0.1:3128) is piped to the gateway's per-profile proxy socket.
export const bridge = `const net=require('node:net');
net.createServer(a=>{const b=net.connect('/egress/proxy.sock');
a.on('error',()=>b.destroy()); b.on('error',()=>a.destroy());
a.on('close',()=>b.destroy()); b.on('close',()=>a.destroy()); a.pipe(b).pipe(a);
}).listen(3128,'127.0.0.1');`;
