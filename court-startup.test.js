const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const fn=name=>html.match(new RegExp('^(?:async )?function '+name+'\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^\\}','m'))[0];
function setup(overrides={}){
 const grid={innerHTML:'Loading courts'};const calls=[];let timer;
 const c=vm.createContext({$:()=>grid,console:{error:()=>{},warn:()=>{}},
 setTimeout:cb=>{timer=cb;return 1},clearTimeout:()=>calls.push('clear'),
 refreshHostBookingSession:async()=>true,applyHostChrome:()=>{},
 renderCourts:async()=>{calls.push('render');grid.innerHTML='Court 1'},
 expireStaleVerifyingBookings:()=>{calls.push('cleanup');return new Promise(()=>{})},...overrides});
 vm.runInContext(fn('showCourtLoadingRecovery')+fn('initializePublicCourts'),c);
 return {c,grid,calls,timeout:()=>timer()};
}
test('court startup renders before cleanup and does not await a stalled cleanup',async()=>{
 const {c,calls,grid}=setup();assert.equal(await c.initializePublicCourts(),true);
 assert.deepEqual(calls,['render','cleanup','clear']);assert.equal(grid.innerHTML,'Court 1');
});
test('a stalled court request offers retry and can still finish successfully',async()=>{
 let finish;const done=new Promise(r=>finish=r);const x=setup({renderCourts:async()=>{await done;x.grid.innerHTML='Court 1'}});
 const started=x.c.initializePublicCourts();await Promise.resolve();x.timeout();
 assert.match(x.grid.innerHTML,/Retry loading courts/);finish();assert.equal(await started,true);assert.equal(x.grid.innerHTML,'Court 1');
});
test('a failed court request replaces the spinner with a recovery message',async()=>{
 const {c,grid,calls}=setup({renderCourts:async()=>{throw Error('Network unavailable')}});
 assert.equal(await c.initializePublicCourts(),false);assert.match(grid.innerHTML,/Retry loading courts/);assert.deepEqual(calls,['clear']);
});
test('host redirects do not expose the booking page or start cleanup',async()=>{
 const {c,calls}=setup({refreshHostBookingSession:async()=>false});assert.equal(await c.initializePublicCourts(),false);assert.deepEqual(calls,['clear']);
});
