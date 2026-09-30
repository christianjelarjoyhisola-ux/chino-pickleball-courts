const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
function worker(fetch){const c=vm.createContext({URL,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,fetch});vm.runInContext(fs.readFileSync('_worker.js','utf8').replace('export default {','globalThis.worker = {'),c);return c.worker;}
const root='https://chinopickleballcourt.com/api/backend';
test('fresh JWT clock skew retries the same authenticated read until the database accepts it',async()=>{
 let calls=0;
 const w=worker(async(url,init)=>{
  assert.equal(init.headers.get('Authorization'),'Bearer original-token');
  calls++;
  return calls===1?new Response('{"code":"PGRST303","message":"JWT issued at future"}',{status:401}):new Response('[{"role":"owner","status":"active"}]');
 });
 const r=await w.fetch(new Request(root+'/rest/v1/accounts',{headers:{Authorization:'Bearer original-token'}}),{});
 assert.equal(r.status,200);assert.equal(calls,2);
});
test('clock skew never causes a write to be replayed',async()=>{
 let calls=0;const w=worker(async()=>{calls++;return new Response('{"code":"PGRST303","message":"JWT issued at future"}',{status:401})});
 const r=await w.fetch(new Request(root+'/rest/v1/bookings',{method:'POST',body:'{}'}),{});
 assert.equal(r.status,401);assert.equal(calls,1);
});
test('login transport streams credentials only to the fixed auth endpoint and never forwards cookies',async()=>{
 let captured;const w=worker(async(url,init)=>{captured={url,init,body:await new Response(init.body).text()};return new Response('{"error":"invalid_credentials"}',{status:400})});
 const response=await w.fetch(new Request(root+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'private-cookie',apikey:'caller-key',Origin:'https://chinopickleballcourt.com'},body:'{"email":"test@example.com","password":"test-only"}'}),{});
 assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(captured.url,'https://wskzptxekldhsxluhgos.supabase.co/auth/v1/token?grant_type=password');assert.equal(captured.init.headers.get('Cookie'),null);assert.notEqual(captured.init.headers.get('apikey'),'caller-key');assert.match(captured.body,/test-only/);
});
test('account lookups retain the caller JWT and upstream denial; no service role or permission bypass',async()=>{
 const w=worker(async(url,init)=>{assert.match(url,/\/rest\/v1\/accounts\?id=eq.user-123/);assert.equal(init.headers.get('Authorization'),'Bearer expired-test-token');return new Response('{"message":"JWT expired"}',{status:401})});
 const r=await w.fetch(new Request(root+'/rest/v1/accounts?id=eq.user-123',{headers:{Authorization:'Bearer expired-test-token'}}),{});assert.equal(r.status,401);assert.match(await r.text(),/JWT expired/);
});
test('foreign origins, unknown paths and auth administration routes are blocked',async()=>{
 const w=worker(()=>assert.fail('Invalid route reached upstream'));
 for(const path of ['/auth/v1/admin/users','/storage/v1/object/private','/auth/v1/unknown'])assert.equal((await w.fetch(new Request(root+path),{})).status,404);
 assert.equal((await w.fetch(new Request(root+'/rest/v1/accounts',{headers:{Origin:'https://unrelated.example'}}),{})).status,403);
});
test('only the dedicated project auth and REST use the same-origin connection; development stays direct',()=>{
 const s=fs.readFileSync('supabase-config.js','utf8');const fn=s.match(/^function _pbBackendEndpoint\([^\n]*\)\s*\{[\s\S]*?^\}/m)[0];
 const c=vm.createContext({URL,SUPABASE_URL:'https://wskzptxekldhsxluhgos.supabase.co',location:{hostname:'chinopickleballcourt.com'}});vm.runInContext(fn,c);
 const url='https://wskzptxekldhsxluhgos.supabase.co/rest/v1/accounts?select=*';assert.equal(c._pbBackendEndpoint(url),'/api/backend/rest/v1/accounts?select=*');
 assert.equal(c._pbBackendEndpoint('https://other.example/rest/v1/accounts'),'https://other.example/rest/v1/accounts');c.location.hostname='localhost';assert.equal(c._pbBackendEndpoint(url),url);
});
