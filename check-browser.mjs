// Run inside the gateway: docker compose exec -T gateway node check-browser.mjs
// Disposable browser with an anonymous filesystem, independent of the profile registry.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {startProxy} from './src/egress/proxy.ts';
import {bridge} from './src/egress/bridge.ts';
const run = promisify(execFile);
const PREFIX = process.env.ARB_PREFIX || 'arb';
const id = PREFIX+'-check-'+randomUUID();
const dir = (process.env.EGRESS_DIR || '/run/arb-egress')+'/'+id;
const proxy = await startProxy(dir,()=>['example.com']);
const docker = async (...args) => {
  try { return (await run('docker',args,{timeout:45000})).stdout; }
  catch { throw Error('Disposable browser command failed'); }
};
try {
  await docker('run','-d','--rm','--network','none','--cap-drop=ALL','--security-opt','no-new-privileges',
    '--name',id,'--mount',`type=volume,src=${PREFIX}-egress,dst=/egress,volume-subpath=${id},readonly`,
    `${PREFIX}-computer:dev`,'node','-e',bridge);
  const ab = (...args)=>docker('exec',id,'agent-browser','--json','--args',
    '--no-sandbox,--proxy-server=http://127.0.0.1:3128,--proxy-bypass-list=<-loopback>,--disable-quic',...args);
  await ab('open','https://example.com');
  assert.equal(JSON.parse(await ab('get','title')).data.title,'Example Domain');
  const stream = JSON.parse(await ab('stream','status'));
  assert.ok(stream.data.port > 0);
  await assert.rejects(ab('open','https://example.org'));
  await assert.rejects(ab('open','file:///etc/hosts'));
  console.log('Disposable Chromium navigation, allowlist, file policy and stream status passed');
} finally {
  await docker('rm','-f',id).catch(()=>{});
  proxy.close();
  rmSync(dir,{recursive:true,force:true});
}
