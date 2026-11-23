import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

test('compressed JSON with trailing bytes cannot terminate the HTTP process', async t => {
  // A vulnerable parser throws asynchronously after the response; isolate it so a
  // regression fails this test instead of terminating the entire test runner.
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import express from 'express';
    const app=express();app.use(express.json({limit:'2kb'}));
    app.post('/',(_req,res)=>res.json({ok:true}));
    app.get('/healthz',(_req,res)=>res.json({ok:true}));
    app.use((error,_req,res,_next)=>res.status(error.status??400).json({ok:false}));
    const server=app.listen(0,'127.0.0.1',()=>console.log(server.address().port));
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `],{stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){const closed=once(child,'exit');child.kill('SIGTERM');await closed;}});
  child.stderr.resume();
  const port=await new Promise<number>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('HTTP parser fixture did not start')),5000);
    child.stdout.once('data',chunk=>{clearTimeout(timeout);resolve(Number(String(chunk).trim()));});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`HTTP parser fixture exited before startup (${code})`));});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
  });
  const base=`http://127.0.0.1:${port}`;
  const compressed=Buffer.concat([gzipSync(Buffer.from('{"value":"synthetic"}')),Buffer.from('invalid gzip trailer')]);
  try {await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body:new Uint8Array(compressed),signal:AbortSignal.timeout(3000)});}catch{ /* Either rejection or a successful parse is valid; the process must survive. */ }
  const health=await fetch(base+'/healthz',{signal:AbortSignal.timeout(3000)});
  assert.equal(health.status,200);
  assert.equal(child.exitCode,null);
});
