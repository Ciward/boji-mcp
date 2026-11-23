import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { requestWithHost } from './helpers/http.js';
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
test('OAuth + actual MCP SDK + browser API share one durable ledger and enforce boundaries',async()=>{
 const port=await freePort(),base=`http://127.0.0.1:${port}`,dir=mkdtempSync(join(tmpdir(),'boji-integration-')),password=randomBytes(24).toString('hex');
 const {app,store}=createApp({host:'127.0.0.1',port,publicUrl:base,dataDir:dir,timezone:'Asia/Shanghai',adminPassword:password,webDir:join(dir,'nonexistent')});
 const server=app.listen(port,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const client=new Client({name:'boji-integration-test',version:'1'});
 const call=async(path:string,body?:unknown,headers:Record<string,string>={},method=body===undefined?'GET':'POST')=>fetch(base+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual'});
 try{
  assert.equal((await call('/api/v1/meals')).status,401);
  const unauth=await call('/mcp',{});assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate')!,/resource_metadata/);
  const requestedScope=unauth.headers.get('www-authenticate')!.match(/scope="([^"]+)"/)![1];assert.equal(requestedScope,'health.read health.write');
  const meta=await (await call('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(meta.resource,base+'/mcp');
  const login=await call('/api/v1/login',{password},{Origin:base});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0],csrf=(await login.json()).csrf_token;
  assert.equal((await call('/api/v1/meals',{}, {Cookie:cookie})).status,403);
  const registered=await (await call('/oauth/register',{client_name:'Boji test',redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'})).json();
  async function authorize(scope:string){
   const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const authQuery=new URLSearchParams({client_id:registered.client_id,redirect_uri:'https://client.example/callback',response_type:'code',scope:scope,resource:base+'/mcp',code_challenge:challenge,code_challenge_method:'S256',state:'e2e-state'});
  const page=await call('/oauth/authorize?'+authQuery,undefined,{Cookie:cookie});assert.equal(page.status,200);const html=await page.text();
  const requestId=html.match(/name="request_id" value="([^"]+)"/)![1];
  const consent=await fetch(base+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({request_id:requestId,csrf_token:csrf,decision:'approve'})});assert.equal(consent.status,303);
  const redirect=new URL(consent.headers.get('location')!);assert.equal(redirect.searchParams.get('state'),'e2e-state');assert.equal(redirect.searchParams.get('iss'),base);
  const tokenResponse=await fetch(base+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:registered.client_id,redirect_uri:'https://client.example/callback',grant_type:'authorization_code',code:redirect.searchParams.get('code')!,code_verifier:verifier,resource:base+'/mcp'})});
   assert.equal(tokenResponse.status,200);const result=await tokenResponse.json();assert.ok(result.access_token);return result;
  }
  const tokens=await authorize(requestedScope);
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+tokens.access_token}}}));
  const tools=await client.listTools();assert.equal(tools.tools.length,16);
  const listed=await call('/mcp',{jsonrpc:'2.0',id:'permissions',method:'tools/list'},{Authorization:'Bearer '+tokens.access_token,Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'});
  assert.equal(listed.status,200);
  const wireTools=(await listed.json()).result.tools as Array<{name:string;securitySchemes:unknown;_meta:{securitySchemes:unknown};annotations:{readOnlyHint:boolean}}>;
  const expectedToolScopes:Record<string,string>={boji_get_context:'health.read',boji_record_meal:'health.write',boji_get_meal:'health.read',boji_list_meals:'health.read',boji_update_meal:'health.write',boji_delete_meal:'health.write',boji_restore_meal:'health.write',boji_get_summary:'health.read',boji_get_source_status:'health.read',boji_get_trends:'health.read',boji_search_food_library:'health.read',boji_get_food_library_item:'health.read',boji_record_food_library_item:'health.write',boji_update_food_library_item:'health.write',boji_delete_food_library_item:'health.write',boji_restore_food_library_item:'health.write'};
  assert.deepEqual(new Set(wireTools.map(tool=>tool.name)),new Set(Object.keys(expectedToolScopes)));
  assert.equal(wireTools.length,Object.keys(expectedToolScopes).length);
  for(const tool of wireTools){
   const required=[{type:'oauth2',scopes:[expectedToolScopes[tool.name]]}];
   assert.deepEqual(tool.securitySchemes,required,tool.name+' top-level permissions');
   assert.deepEqual(tool._meta!.securitySchemes,required,tool.name+' compatibility permissions');
  }
  const context=await client.callTool({name:'boji_get_context',arguments:{}});assert.equal((context.structuredContent as any).timezone,'Asia/Shanghai');
  // Expire only this isolated test token and renew via the actual SDK's OAuth provider.
  store.db.prepare('UPDATE auth_access_tokens SET expires_at = ? WHERE token_hash = ?').run(Math.floor(Date.now()/1000)-1,createHash('sha256').update(tokens.access_token).digest('hex'));
  let currentTokens={...tokens,issuer:base},refreshes=0;
  const refreshedClient=new Client({name:'boji-refresh-regression',version:'1'});
  await refreshedClient.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{authProvider:{
   redirectUrl:'https://client.example/callback',clientMetadata:{redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'},
   clientInformation:()=>({...registered,issuer:base}),saveClientInformation:()=>assert.fail('existing client registration must be reused'),
   tokens:()=>currentTokens,saveTokens:value=>{currentTokens=value;refreshes++},
   redirectToAuthorization:()=>assert.fail('expired access token must refresh without interactive authorization'),
   saveCodeVerifier:()=>assert.fail('refresh must not start a new PKCE flow'),codeVerifier:()=>assert.fail('refresh must not use a PKCE verifier'),
  }}));
  try{
   assert.equal(refreshes,1);assert.notEqual(currentTokens.access_token,tokens.access_token);assert.notEqual(currentTokens.refresh_token,tokens.refresh_token);
   assert.equal(currentTokens.scope,requestedScope);
   const renewed=await refreshedClient.callTool({name:'boji_get_context',arguments:{}});assert.equal(renewed.isError,undefined);
  }finally{await refreshedClient.close();}
  await client.close();
  // The renewed token must retain write access for the record/edit/delete workflow below.
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+currentTokens.access_token}}}));
  const meal={title:'SDK 验证午餐',occurred_at:'2026-10-20T12:00:00+08:00',meal_type:'lunch',items:[{name:'酸奶',nutrients:{energy_kcal:120,protein_g:10,carbs_g:12,fat_g:4},consumed_fraction:1,evidence:'label',confidence:'high'}]};
  const saved=await client.callTool({name:'boji_record_meal',arguments:{idempotency_key:'mcp-test-create-1',meal}});assert.equal(saved.isError,undefined);const record=(saved.structuredContent as any).meal;
  const read=await (await call('/api/v1/meals/'+record.id,undefined,{Cookie:cookie})).json();assert.equal(read.meal.title,meal.title);
  const edit=await call('/api/v1/meals/'+record.id,{idempotency_key:'web-edit-0001',expected_version:1,meal:{...meal,title:'人类修正',items:[{...meal.items[0],consumed_fraction:.5}]}},{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf},'PUT');assert.equal(edit.status,200);
  const reread=await client.callTool({name:'boji_get_meal',arguments:{id:record.id}});assert.equal((reread.structuredContent as any).meal.version,2);assert.equal((reread.structuredContent as any).meal.totals.energy_kcal,60);
  const remove=await client.callTool({name:'boji_delete_meal',arguments:{id:record.id,expected_version:2,idempotency_key:'mcp-delete-0001'}});assert.equal((remove.structuredContent as any).persisted,true);
  const summary=await (await call('/api/v1/summary?date=2026-10-20',undefined,{Cookie:cookie})).json();assert.equal(summary.meal_count,0);
  const restore=await call('/api/v1/meals/'+record.id+'/restore',{expected_version:3,idempotency_key:'restore-web-0001'},{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf});assert.equal(restore.status,200);
  const source=await (await call('/api/v1/sources',{name:'API bridge test',kind:'health_auto_export'},{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf})).json();assert.ok(source.token);
  assert.equal((await call('/ingest/v1/'+source.source.id,{data:{metrics:[]}}, {Authorization:'Bearer '+tokens.access_token})).status,401);
  assert.equal((await call('/mcp',{}, {Authorization:'Bearer '+source.token})).status,401);
  const bridge=await call('/ingest/v1/'+source.source.id,{data:{metrics:[{name:'step_count',units:'count',data:[{qty:1234,date:'2026-10-20 12:00:00 +0800'}]}]}},{Authorization:'Bearer '+source.token});assert.equal(bridge.status,200,await bridge.text());
  const readTokens=await authorize('health.read');
  const readonlyClient=new Client({name:'boji-readonly-regression',version:'1'});
  await readonlyClient.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+readTokens.access_token}}}));
  try{
   const before=store.db.prepare('SELECT count(*) AS n FROM meals').get()!.n;
   for(const [name,arguments_] of [
    ['boji_record_meal',{idempotency_key:'readonly-must-not-write',meal}],
    ['boji_update_meal',{id:record.id,idempotency_key:'readonly-must-not-update',expected_version:4,meal}],
    ['boji_delete_meal',{id:record.id,idempotency_key:'readonly-must-not-delete',expected_version:4}],
    ['boji_restore_meal',{id:record.id,idempotency_key:'readonly-must-not-restore',expected_version:4}],
   ] as const){
    const refused=await readonlyClient.callTool({name,arguments:arguments_});
    assert.equal(refused.isError,true,name);
    const challenge=(refused._meta!['mcp/www_authenticate'] as string[])[0];
    assert.match(challenge,/error="insufficient_scope"/);assert.match(challenge,/error_description="[^"]+"/);
    assert.ok(challenge.includes('resource_metadata="'+base+'/.well-known/oauth-protected-resource/mcp"'));
    assert.match(challenge,/scope="health.read health.write"/);
   }
   assert.equal(store.db.prepare('SELECT count(*) AS n FROM meals').get()!.n,before);
   assert.equal(store.db.prepare('SELECT count(*) AS n FROM meal_history').get()!.n,4);
   assert.equal((await readonlyClient.callTool({name:'boji_get_context',arguments:{}})).isError,undefined);
   assert.equal(store.db.prepare('SELECT count(*) AS n FROM auth_grants WHERE revoked_at IS NOT NULL').get()!.n,0);
  }finally{await readonlyClient.close();}
  const exportData=await (await call('/api/v1/export',undefined,{Cookie:cookie})).text();assert.ok(!exportData.includes(source.token));assert.ok(!exportData.includes(tokens.access_token));assert.ok(!exportData.includes(password));
  assert.equal((await call('/api/v1/meals',{}, {Cookie:cookie,Origin:'https://evil.example','X-CSRF-Token':csrf})).status,403);
 }finally{await client.close();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});

test('configured domain aliases accept only their own browser Origin and publish matching OAuth metadata',async()=>{
 const port=await freePort(),base=`http://127.0.0.1:${port}`,dir=mkdtempSync(join(tmpdir(),'boji-alias-'));
 const primary='https://boji.example.org',legacy='https://legacy-boji.example.org';
 const {app,store}=createApp({host:'127.0.0.1',port,publicUrl:primary,publicUrlAliases:[legacy],dataDir:dir,timezone:'Asia/Shanghai',adminPassword:'alias-test-password-123456789',webDir:join(dir,'nonexistent')});
 const server=app.listen(port,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{
  for(const origin of [primary,legacy]){
   const headers={Host:new URL(origin).host,Origin:origin};
   assert.equal((await requestWithHost(base+'/healthz',{headers})).status,200);
   const metadata=await (await requestWithHost(base+'/.well-known/oauth-authorization-server',{headers})).json();assert.equal(metadata.issuer,origin);
   const challenge=await requestWithHost(base+'/mcp',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(challenge.status,401);assert.ok(challenge.headers.get('www-authenticate')!.includes(origin+'/.well-known/oauth-protected-resource/mcp'));
  }
  assert.equal((await requestWithHost(base+'/healthz',{headers:{Host:'evil.test'}})).status,403);
  assert.equal((await requestWithHost(base+'/healthz',{headers:{Host:new URL(primary).host,Origin:legacy}})).status,403);
  assert.equal((await requestWithHost(base+'/healthz',{headers:{Host:new URL(legacy).host,Origin:'https://evil.test'}})).status,403);
  const forged=await (await requestWithHost(base+'/.well-known/oauth-authorization-server',{headers:{Host:new URL(primary).host,'X-Forwarded-Host':'evil.test','X-Forwarded-Proto':'http'}})).json();assert.equal(forged.issuer,primary);
 }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
