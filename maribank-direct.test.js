const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = f => fs.readFileSync(f,'utf8');
const fn = (file,name) => read(file).match(new RegExp('^(?:async )?function '+name+'\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^\\}', 'm'))[0];

test('MariBank uses its own account and QR; switching to GCash restores the GCash recipient', () => {
 const nodes = new Map();
 const get = id => { if(!nodes.has(id)) nodes.set(id,{style:{},querySelector:()=>null,querySelectorAll:()=>[]});return nodes.get(id); };
 const c=vm.createContext({$:get,paymentReceiverSettings:{},paymentMethods:{},gcashSettings:{},maskGcashOwnerName:x=>x,applyPaymentMethodVisibility:()=>{},updatePaymentAmountUI:()=>{}});
 vm.runInContext(fn('index.html','paymentReceiverKey')+fn('index.html','applyPaymentSettings')+fn('index.html','syncGcashSharedPanel'),c);
 const settings={payment_method_maribank:'1',gcash_merchant_number:'09123456789',gcash_merchant_name:'GCash recipient',gcash_qr_image:'gcash-qr'};
 c.applyPaymentSettings(settings);
 assert.equal(c.paymentMethods.maribank,false);
 Object.assign(settings,{maribank_merchant_number:'15521507144',maribank_merchant_name:'KRISTIE LOU VILLANUEVA',maribank_qr_image:'assets/maribank-qr.png'});
 c.applyPaymentSettings(settings);
 assert.equal(c.paymentMethods.maribank,true);
 c.syncGcashSharedPanel('maribank');
 assert.equal(get('gcMerchantNumber').textContent,'15521507144');
 assert.equal(get('gcMerchantName').textContent,'KRISTIE LOU VILLANUEVA');
 assert.equal(get('gcashQrImg').src,'assets/maribank-qr.png');
 c.syncGcashSharedPanel('gcash');
 assert.equal(get('gcMerchantNumber').textContent,'09123456789');
 assert.equal(get('gcashQrImg').src,'gcash-qr');
 assert.equal(c.paymentReceiverKey('maribank'),'maribank');
});

test('direct MariBank receipts are enabled with a dedicated destination parser',()=>{
 const c=vm.createContext({isLegacyDedicatedReceiptProvider:()=>true});
 vm.runInContext(fn('supabase/functions/verify-gcash-receipt/index.ts','isDedicatedReceiptProvider').replace('provider: string','provider'),c);
 assert.equal(c.isDedicatedReceiptProvider('maribank'),true);
 assert.equal(c.isDedicatedReceiptProvider('gcash'),true);
});

test('new MariBank bookings record the direct destination and preserve explicit history',()=>{
 const c=vm.createContext({});
 vm.runInContext(fn('supabase-config.js','normalizePaymentKey')+fn('supabase-config.js','receivedAccountForBooking'),c);
 assert.equal(c.receivedAccountForBooking({paymentMethod:'maribank'}),'maribank');
 assert.equal(c.receivedAccountForBooking({paymentMethod:'maribank',receivedAccount:'gcash'}),'gcash');
});

test('a clock-verified no-date MariBank receipt carries its clock age into settlement',()=>{
 const edge=read('supabase/functions/verify-gcash-receipt/index.ts');
 const from=edge.indexOf('    const clockAgeMinutes =');
 const to=edge.indexOf('    const gcashRecipient',from);
 assert.ok(from>0&&to>from,'receipt age block not found');
 const run=(verification,receiptDateTime)=>{
  const c={providerVerification:verification,bookingStartedAt:new Date('2026-11-17T09:18:13Z'),receiptDateTime};
  vm.runInNewContext(edge.slice(from,to).replace(/const (clockAgeMinutes|receiptAgeMinutes)\b/g,'this.$1')+'',c);
  return c.receiptAgeMinutes;
 };
 const clock={provider:'maribank_direct',timeBasis:'reference_order_and_screen_clock',screenClockCheck:{clockMinutesAfterBooking:4.8}};
 // Real 2026-11-17 case: no printed date, clock 4.8 minutes after booking.
 assert.equal(run(clock,null),4.8);
 // A printed date still wins, and a rejected clock gives no age.
 assert.equal(run(clock,new Date('2026-11-17T09:21:13Z')),3);
 assert.equal(run({...clock,timeBasis:'receipt_timestamp'},null),null);
 assert.equal(run({provider:'gcash'},null),null);
});
