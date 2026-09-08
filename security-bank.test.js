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
  settings.securitybank_qr_image = 'data:image/png;base64,bank-qr';
  ctx.applyPaymentSettings(settings);
  assert.equal(get('securitybankQrImg').src, settings.securitybank_qr_image);
  assert.equal(get('securitybankQrWrap').style.display, '');
  assert.equal(ctx.paymentReceiverSettings.securitybank.qrImage, settings.securitybank_qr_image);
  settings.securitybank_qr_image = '';
  ctx.applyPaymentSettings(settings);
  assert.equal(get('securitybankQrWrap').style.display, 'none');
  settings.payment_method_securitybank = '0';
  ctx.applyPaymentSettings(settings);
  assert.equal(ctx.paymentMethods.securitybank, false);
});

test('Security Bank QR upload and removal use its own setting and preserve other banks', async () => {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, {style:{},value:'',src:''}); return nodes.get(id); };
  const saved = new Map([['gcash_qr_image','gcash-qr'],['pnb_qr_image','pnb-qr']]);
  let readPromise;
  const ctx = vm.createContext({ $:get, Auth:{can:()=>true}, sess:{role:'owner'}, toast:()=>{}, console,
    DB:{saveSetting:async(k,v)=>saved.set(k,v)}, FileReader:class {
      readAsDataURL() { readPromise=this.onload({target:{result:'data:image/png;base64,bank-qr'}}); }
    } });
  vm.runInContext(fn('admin.html','handleQrUpload') + fn('admin.html','removeQr'),ctx);
  ctx.handleQrUpload('securitybank',{target:{files:[{type:'image/png',size:100}],value:'qr.png'}});
  await readPromise;
  assert.equal(saved.get('securitybank_qr_image'),'data:image/png;base64,bank-qr');
  assert.equal(get('securitybankQrPreview').src,saved.get('securitybank_qr_image'));
  assert.equal(get('securitybankQrPreviewWrap').style.display,'');
  await ctx.removeQr('securitybank');
  assert.equal(saved.get('securitybank_qr_image'),'');
  assert.equal(get('securitybankQrPreviewWrap').style.display,'none');
  assert.equal(saved.get('gcash_qr_image'),'gcash-qr');
  assert.equal(saved.get('pnb_qr_image'),'pnb-qr');
  for (const file of [{type:'image/svg+xml',size:100},{type:'image/png',size:6*1024*1024}]) {
    ctx.handleQrUpload('securitybank',{target:{files:[file],value:'bad-upload'}});
    assert.equal(saved.get('securitybank_qr_image'),'');
  }
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

test('Security Bank preserves references and dispatches through its dedicated parser', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fn('index.html','paymentRefMaxLength') + fn('index.html','normalizePaymentRef'),ctx);
  assert.equal(ctx.normalizePaymentRef('SB-123ABC456','securitybank'),'SB-123ABC456');
  const verifier = read('supabase/functions/verify-gcash-receipt/index.ts');
  assert.match(verifier,/provider === "securitybank"[\s\S]*?settings.securitybank_merchant_number/);
  assert.match(verifier,/if \(!isDedicatedReceiptProvider\(provider\)\)[\s\S]*?flags.push\("PROVIDER_REVIEW_REQUIRED"\)/);
  const registry = read('supabase/functions/_shared/receipt-providers/index.ts');
  assert.match(registry,/case "securitybank"/);
  assert.match(registry,/verifySecurityBankReceipt/);
});
