const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');

function paymentFunction(name) {
  const match = read('index.html').match(new RegExp('^function ' + name + '\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^\\}', 'm'));
  assert.ok(match, `Missing ${name}`);
  return match[0];
}

test('all public payment choices expose focus, selection and keyboard activation', () => {
  const page = read('index.html');
  const choices = [...page.matchAll(/<div class="pay-opt(?:"| op-pay-opt)[^>]*>/g)].map(match => match[0]);
  assert.equal(choices.length, 16);
  for (const choice of choices) {
    assert.match(choice, /role="button"/);
    assert.match(choice, /tabindex="0"/);
    assert.match(choice, /aria-pressed="/);
    assert.match(choice, /onkeydown="paymentOptionKeydown\(event\)"/);
  }
  assert.match(page, /\.pay-opt:focus-visible\s*\{[^}]*outline:/);
  const context = vm.createContext({});
  vm.runInContext(paymentFunction('paymentOptionKeydown'), context);
  for (const key of ['Enter', ' ']) {
    let clicks = 0, prevented = 0;
    const option = { getAttribute:() => null, click:() => clicks++ };
    const event = { key, currentTarget:option, preventDefault:() => prevented++ };
    context.paymentOptionKeydown(event);
    assert.equal(clicks, 1);
    assert.equal(prevented, 1);
    option.getAttribute = () => 'true';
    context.paymentOptionKeydown(event);
    assert.equal(clicks, 1, 'Locked choices must not activate from the keyboard');
    option.getAttribute = () => null;
    context.paymentOptionKeydown({ ...event, repeat:true });
    assert.equal(clicks, 1, 'Holding a key must not repeatedly change payment state');
    context.paymentOptionKeydown({ ...event, key:'Tab' });
    assert.equal(clicks, 1);
  }
});

test('regular and Open Play payment selection announce only their own active choice', () => {
  const makeNode = (method = '') => {
    const attrs = {}, classes = new Set();
    return { value:'', dataset:{ m:method }, style:{}, attrs, classes,
      setAttribute:(key, value) => attrs[key] = value,
      removeAttribute:key => delete attrs[key],
      classList:{ toggle:(key, selected) => selected ? classes.add(key) : classes.delete(key) },
    };
  };
  const regular = ['gcash', 'cash'].map(makeNode);
  const openPlay = ['gcash', 'cash'].map(makeNode);
  const nodes = new Map();
  const get = id => {
    if (['payMethodNote', 'opPayInfo', 'refMethodLabel'].includes(id)) return null;
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  const context = vm.createContext({
    $:get, document:{ querySelectorAll:selector => selector === '.bpay-methods .pay-opt' ? regular : selector === '#opPayOpts .pay-opt' ? openPlay : [...regular, ...openPlay] },
    paymentMethods:{ cash:true, gcash:true, pnb:false }, _opSignupData:{},
    _bookingSubmissionInFlight:false, _receiptFile:null, _receiptUploadState:{ status:'idle' }, gcashSettings:{},
    toast:() => {}, isDigitalPayMethod:method => method !== 'cash', clearBookingInvalid:() => {},
    isVerifiedHostBooking:() => false, hostBookingDepositEligible:() => false,
    syncGcashSharedPanel:() => {}, syncBookingRefUi:() => {}, updatePaymentAmountUI:() => {},
    setBookingReceiptContinueState:() => {}, saveGuestBookingResume:() => {},
  });
  vm.runInContext(paymentFunction('pickPay') + '\n' + paymentFunction('opPickPay'), context);
  context.pickPay('cash');
  assert.equal(get('bPay').value, 'cash');
  assert.deepEqual(regular.map(node => node.attrs['aria-pressed']), ['false', 'true']);
  context.opPickPay('gcash');
  assert.equal(context._opSignupData.payMethod, 'gcash');
  assert.deepEqual(openPlay.map(node => node.attrs['aria-pressed']), ['true', 'false']);
  assert.deepEqual(regular.map(node => node.attrs['aria-pressed']), ['false', 'true']);
  context.pickPay('gcash');
  assert.deepEqual(regular.map(node => node.attrs['aria-pressed']), ['true', 'false']);
  context._bookingSubmissionInFlight = true;
  context.pickPay('cash');
  assert.equal(get('bPay').value, 'gcash');
  context.opPickPay('pnb');
  assert.equal(context._opSignupData.payMethod, 'gcash');
});

test('official payment marks are vendored locally with stable dimensions', () => {
  const expectedDimensions = {
    gcash: [256, 256],
    'bdo-pay': [256, 256],
    maya: [256, 256],
    bpi: [256, 256],
    gotyme: [64, 64],
    maribank: [122, 122],
    pnb: [256, 256],
  };
  for (const [method, dimensions] of Object.entries(expectedDimensions)) {
    const path = `assets/payment-methods/${method}.png`;
    assert.ok(fs.existsSync(path), `${method} icon must exist`);
    assert.ok(fs.statSync(path).size > 1_000, `${method} icon must not be an empty placeholder`);
    const image = fs.readFileSync(path);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${method} must be a valid PNG`);
    assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], dimensions, `${method} dimensions changed unexpectedly`);
  }
  assert.ok(fs.existsSync('assets/payment-methods/cash.svg'), 'cash icon must exist');
  assert.ok(fs.statSync('assets/payment-methods/cash.svg').size > 250, 'cash icon must not be an empty placeholder');
  assert.match(read('assets/payment-methods/cash.svg'), /viewBox="0 0 64 64"/);

  const helper = read('payment-method-brand.js');
  assert.match(helper, /gcash: 'assets\/payment-methods\/gcash\.png'/);
  assert.match(helper, /bdopay: 'assets\/payment-methods\/bdo-pay\.png'/);
  assert.match(helper, /maya: 'assets\/payment-methods\/maya\.png'/);
  assert.match(helper, /bpi: 'assets\/payment-methods\/bpi\.png'/);
  assert.match(helper, /gotyme: 'assets\/payment-methods\/gotyme\.png'/);
  assert.match(helper, /maribank: 'assets\/payment-methods\/maribank\.png'/);
  assert.match(helper, /pnb: 'assets\/payment-methods\/pnb\.png'/);
  assert.match(helper, /cash: 'assets\/payment-methods\/cash\.svg'/);
  assert.match(helper, /width="32" height="32"/);
  assert.match(helper, /alt="" aria-hidden="true"/);
});

test('player and owner payment surfaces use the shared local brand system', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  const deploy = read('deploy-cloudflare-pages.ps1');

  for (const source of [page, admin]) {
    assert.match(source, /payment-method-brand\.css\?v=20260901-payment-icons-v2/);
    assert.match(source, /payment-method-brand\.js\?v=20260901-payment-icons-v2/);
    assert.doesNotMatch(source, /<img[^>]+src="https?:\/\/[^">]+"[^>]+payment-method/i);
  }

  const pickerAssets = {
    Gcash: 'gcash.png',
    Bdopay: 'bdo-pay.png',
    Maya: 'maya.png',
    Bpi: 'bpi.png',
    Gotyme: 'gotyme.png',
    Maribank: 'maribank.png',
    Pnb: 'pnb.png',
    Cash: 'cash.svg',
  };
  for (const [idSuffix, filename] of Object.entries(pickerAssets)) {
    assert.match(page, new RegExp(`id="payOpt${idSuffix}"[\\s\\S]{0,500}?assets/payment-methods/${filename.replace('.', '\\.')}"`));
  }
  assert.match(page, /function paymentMethodBrandLabelHtml/);
  for (const method of ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb', 'cash']) {
    assert.match(page, new RegExp(`paymentMethodBrandMarkHtml\\('${method}', 'po-ico pm-brand-mark--compact'\\)`));
  }
  assert.match(page, /\.pay-opts\.bpay-methods,[\s\S]{0,100}?\.pay-opts\.op-pay-opts\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}/);
  assert.match(page, /renderPaymentMethodBrandLabel\(title, method, profile\.title\)/);

  assert.match(admin, /class="pm-toggle-grid"/);
  for (const [idSuffix, filename] of Object.entries(pickerAssets)) {
    assert.match(admin, new RegExp(`id="payMethod${idSuffix}On"[\\s\\S]{0,500}?assets/payment-methods/${filename.replace('.', '\\.')}"`));
  }
  assert.match(admin, /renderPaymentMethodBrandLabel\(\$\('vmMethod'\), b\.paymentMethod\)/);
  assert.match(admin, /paymentMethodBrandLabelHtml\(b\.paymentMethod\)/);

  assert.match(deploy, /"payment-method-brand\.css"/);
  assert.match(deploy, /"payment-method-brand\.js"/);
  for (const filename of Object.values(pickerAssets)) {
    assert.match(deploy, new RegExp(`"assets/payment-methods/${filename.replace('.', '\\.')}"`));
  }
  assert.match(deploy, /\$destination = Join-Path \$stagingDir \$file/);
});

test('payment history uses the shared local provider marks without changing review logic', () => {
  const history = read('host-balance-admin.js');
  assert.match(history, /PaymentMethodBrand/);
  assert.match(history, /renderLabel/);
  assert.match(history, /renderPaymentMethodReference\(balanceTabMeta, providerMethod, balanceReference\)/);
  assert.match(history, /renderPaymentMethodReference\(byId\('hostDepositTab'\)[\s\S]{0,160}?depositMethod, depositReference\)/);
  assert.match(history, /appendPaymentMethodSummary\(meta, 'Method', payment\.paymentProvider/);
  assert.doesNotMatch(history, /https?:\/\/[^'"`]+payment-method/i);
});
