const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const source=fs.readFileSync('_worker.js','utf8').replace('export default {','globalThis.worker = {');
function worker(fetch){const c=vm.createContext({URL,Request,Response,Headers,AbortSignal,AbortController,setTimeout,clearTimeout,console,fetch});vm.runInContext(source,c);return c.worker;}
const env={ASSETS:{fetch:async()=>new Response('asset')}};
test('public court reads use the fixed database and anonymous credentials, ignoring caller auth and query expansion',async()=>{
 let called;const w=worker(async(url,init)=>{called={url:String(url),init};return new Response('[{"id":"court1"}]')});
 const r=await w.fetch(new Request('https://chinopickleballcourt.com/api/public-data/rest/v1/courts?select=*,bookings(*)',{headers:{Authorization:'Bearer private-token',Cookie:'secret'}}),env);
 assert.equal(r.status,200);assert.match(called.url,/^https:\/\/wskzptxekldhsxluhgos.supabase.co\/rest\/v1\/courts\?select=\*&order=id.asc$/);
 assert.notEqual(called.init.headers.Authorization,'Bearer private-token');assert.equal(called.init.headers.Cookie,undefined);assert.equal(r.headers.get('cache-control'),'no-store');
});
test('only anonymous read endpoints are exposed; writes and private tables never reach the database',async()=>{
 const w=worker(()=>assert.fail('Disallowed request reached upstream'));
 for(const [path,method] of [['bookings','GET'],['settings','POST'],['rpc/confirm_booking_transaction','GET'],['courts','DELETE']]){
 const r=await w.fetch(new Request('https://chinopickleballcourt.com/api/public-data/rest/v1/'+path,{method}),env);assert.equal(r.status,404);
 }
});
test('availability dates are forwarded, unsupported parameters are dropped, and upstream failures remain errors',async()=>{
 let target;const w=worker(async url=>{target=String(url);return new Response('{"message":"down"}',{status:503})});
 const r=await w.fetch(new Request('https://chinopickleballcourt.com/api/public-data/rest/v1/rpc/get_public_booking_availability?p_date=2026-09-30&p_court_id=null&select=private'),env);
 assert.equal(r.status,503);assert.match(target,/p_date=2026-09-30$/);assert.doesNotMatch(target,/private|null/);
});
test('public browser data bypasses stored sessions and uses same-origin transport',()=>{
 const s=fs.readFileSync('supabase-config.js','utf8');
 assert.match(s,/persistSession: false, autoRefreshToken: false, detectSessionInUrl: false/);
 assert.match(s,/const accountRole = PB_PRIVATE_DATA_SURFACE \? await _pbCurrentAccountRole\(\) : ''/);
 assert.match(s,/'\/api\/public-data' \+ target.pathname \+ target.search/);
 assert.match(s,/throw new Error\('Court availability could not be loaded/);
});
