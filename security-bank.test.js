const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = file => fs.readFileSync(file, 'utf8');
function fn(file, name) {
  return read(file).match(new RegExp('^(?:async )?function ' + name + '\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^\\}', 'm'))[0];
}

test('Security Bank requires its own complete enabled account, without GCash fallback', () => {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, {style:{}}); return nodes.get(id); };
  const ctx = vm.createContext({ $:get, paymentReceiverSettings:{}, gcashSettings:{}, paymentMethods:{},
    maskGcashOwnerName:x=>x, applyPaymentMethodVisibility:()=>{}, updatePaymentAmountUI:()=>{} });
  vm.runInContext(fn('index.html','paymentReceiverKey') + fn('index.html','applyPaymentSettings'), ctx);
  const settings = { payment_method_securitybank:'1', gcash_merchant_name:'Other account', gcash_merchant_number:'09123456789' };
  ctx.applyPaymentSettings(settings);
  assert.equal(ctx.paymentMethods.securitybank, false);
  settings.securitybank_merchant_name = 'CHINO Bank Account';
  ctx.applyPaymentSettings(settings);
  assert.equal(ctx.paymentMethods.securitybank, false);
  settings.securitybank_merchant_number = '000012345678';
  ctx.applyPaymentSettings(settings);
  assert.equal(ctx.paymentMethods.securitybank, true);
  assert.equal(get('sbMerchantNumber').textContent, '000012345678');
  assert.equal(get('sbMerchantName').textContent, 'CHINO Bank Account');
  assert.equal(ctx.paymentReceiverKey('securitybank'), 'securitybank');
  settings.payment_method_securitybank = '0';
  ctx.applyPaymentSettings(settings);
  assert.equal(ctx.paymentMethods.securitybank, false);
});

test('owner settings reject missing bank details and preserve leading zeroes when saved', async () => {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, {value:'',checked:false,src:''}); return nodes.get(id); };
  const saved = new Map();
  const ctx = vm.createContext({ $:get, Auth:{can:()=>true}, sess:{role:'owner'}, toast:()=>{},
    DB:{saveSetting:async(k,v)=>saved.set(k,v)}, renderPaymentSettings:async()=>{} });
  vm.runInContext(fn('admin.html','savePaymentSettings'),ctx);
  get('payMethodSecuritybankOn').checked = true;
  await ctx.savePaymentSettings();
  assert.equal(saved.size, 0);
  get('securitybankNameInput').value = 'CHINO Account';
  get('securitybankNumInput').value = '000012345678';
  await ctx.savePaymentSettings();
  assert.equal(saved.get('payment_method_securitybank'),'1');
  assert.equal(saved.get('securitybank_merchant_number'),'000012345678');
  assert.equal(saved.get('securitybank_merchant_name'),'CHINO Account');
});

test('Security Bank references keep letters and never enter automatic receipt approval', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fn('index.html','paymentRefMaxLength') + fn('index.html','normalizePaymentRef'),ctx);
  assert.equal(ctx.normalizePaymentRef('SB-123ABC456','securitybank'),'SB-123ABC456');
  const verifier = read('supabase/functions/verify-gcash-receipt/index.ts');
  assert.match(verifier,/provider === "securitybank"[\s\S]*?settings.securitybank_merchant_number/);
  assert.match(verifier,/if \(!isDedicatedReceiptProvider\(provider\)\)[\s\S]*?flags.push\("PROVIDER_REVIEW_REQUIRED"\)/);
  const registry = read('supabase/functions/_shared/receipt-providers/index.ts');
  assert.doesNotMatch(registry,/"securitybank"/);
});
