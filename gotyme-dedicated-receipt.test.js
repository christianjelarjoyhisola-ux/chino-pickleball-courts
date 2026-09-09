const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const edge = fs.readFileSync(path.join(__dirname, 'supabase/functions/verify-gcash-receipt/index.ts'), 'utf8');
const start = edge.indexOf('    const sourceProviderMatch =');
const end = edge.indexOf('    const bookingCanAutoApprove =', start);
assert.ok(start > 0 && end > start, 'load the production evidence gate');
const evidenceGate = edge.slice(start, end) + '\ncleanEvidence;';

function verifyGate(provider = 'gotyme', comparison = {}, overrides = {}) {
  return vm.runInNewContext(evidenceGate, {
    providerParse: {
      provider,
      receipt: {
        indicators: { providerBrand: true, competingProviderBrand: null },
        reference: { typedMatch: 'not_provided', confidence: 'high' },
        timestamp: { completeness: 'date_time' },
      },
    },
    providerVerification: {
      provider,
      recipientComparison: { phone: 'missing', account: 'suffix_only', name: 'masked_compatible', ...comparison },
    },
    typedRef: '', extractedRef: 'ITO260909055941016',
    extractedAmount: 265, expectedAmount: 265,
    amountExtraction: { reliable: true, ambiguous: false },
    flags: [], duplicateClear: true,
    closeMoney: (a, b) => Math.abs(a - b) <= 0.01,
    ...overrides,
  });
}

test('GoTyme and MariBank QR receipts use configured destination identity with a compatible name', () => {
  for (const provider of ['gotyme', 'maribank']) {
    assert.equal(verifyGate(provider), true, `${provider}: configured masked QR token`);
    assert.equal(verifyGate(provider, { account: 'exact', name: 'exact' }), true);
    for (const account of ['missing', 'not_configured', 'mismatch']) {
      assert.equal(verifyGate(provider, { account }), false, `${provider}: ${account}`);
    }
    for (const name of ['missing', 'not_configured', 'mismatch', 'inconclusive']) {
      assert.equal(verifyGate(provider, { name }), false, `${provider}: ${name}`);
    }
  }
});

test('a QR account never overrides a conflicting phone or account', () => {
  assert.equal(verifyGate('gotyme', { phone: 'mismatch' }), false);
  assert.equal(verifyGate('gotyme', { phone: 'exact', account: 'mismatch' }), false);
  assert.equal(verifyGate('gotyme', { phone: 'exact', account: 'missing' }), true);
  assert.equal(verifyGate('gotyme', { phone: 'last4_only', account: 'missing' }), true);
});

test('GoTyme automatic approval retains amount, timestamp, reference, confidence and replay gates', () => {
  assert.equal(verifyGate('gotyme', {}, { extractedAmount: 530 }), false);
  assert.equal(verifyGate('gotyme', {}, { amountExtraction: { reliable: false, ambiguous: false } }), false);
  assert.equal(verifyGate('gotyme', {}, { amountExtraction: { reliable: true, ambiguous: true } }), false);
  assert.equal(verifyGate('gotyme', {}, { extractedRef: null }), false);
  assert.equal(verifyGate('gotyme', {}, { duplicateClear: false }), false);
  for (const flag of ['LOW_OCR_CONFIDENCE', 'TIME_EXPIRED', 'TIME_UNREADABLE', 'METHOD_MISMATCH', 'DUPLICATE_REF', 'MERCHANT_CONFIG_MISSING']) {
    assert.equal(verifyGate('gotyme', {}, { flags: [flag] }), false, flag);
  }
});

test('GoTyme QR account support does not relax GCash or other bank checks', () => {
  for (const provider of ['gcash', 'maya', 'bdopay', 'bpi']) {
    assert.equal(verifyGate(provider), false, provider);
  }
});

test('configured QR destination token is supplied to both bank parsers and recorded in the audit', () => {
  for (const property of ['expectedRecipientAccount', 'expectedReceiverAccount']) {
    const accountExpression = edge.match(new RegExp(`${property}: (provider === "bdopay"[\\s\\S]*?)\\n\\s*: (?:""|null),`));
    assert.ok(accountExpression, property);
    for (const provider of ['gotyme', 'maribank']) {
      const result = vm.runInNewContext(accountExpression[1] + '\n: null', {
        provider,
        settings: { gcash_qr_receipt_destination_token: 'CONFIGURED_QR_TOKEN' },
      });
      assert.equal(result, 'CONFIGURED_QR_TOKEN', `${property}: ${provider}`);
    }
  }
});

const ocrStart = edge.indexOf('async function runOCR(');
const ocrEnd = edge.indexOf('\nfunction telegramAdminUrl(', ocrStart);
assert.ok(ocrStart > 0 && ocrEnd > ocrStart, 'load the production OCR dispatcher');
const ocrDispatcher = edge.slice(ocrStart, ocrEnd)
  .replace(/async function runOCR\([\s\S]*?\): Promise<OcrResult>/, 'async function runOCR(visionKey, base64, provider, typedRef)');

async function dispatchOcr(provider, visionResult, gaps = []) {
  const observed = [];
  const run = vm.runInNewContext(ocrDispatcher + '\nrunOCR;', {
    googleVisionOcr: async () => visionResult,
    ocrCriticalGaps: text => { observed.push(text); return gaps; },
    errMsg: error => error.message,
    console: { error() {} },
  });
  const result = await run('test-vision-key', 'TEST_IMAGE', provider, '');
  return { result, observed };
}

test('GoTyme parses Google row layout while retaining original OCR and native confidence', async () => {
  const original = 'To\nFrom\nRECIPIENT\nSENDER';
  const layout = 'To RECIPIENT\nFrom SENDER';
  const { result, observed } = await dispatchOcr('gotyme', {
    text: original, layoutText: layout, confidence: 0.9449, confidenceSource: 'native',
  });
  assert.equal(result.text, layout);
  assert.equal(result.originalText, original);
  assert.equal(result.layoutApplied, true);
  assert.equal(result.confidence, 0.9449);
  assert.equal(result.confidenceSource, 'native');
  assert.deepEqual(observed, [layout]);
});

test('GoTyme falls back to original OCR when validated layout is unavailable', async () => {
  for (const layoutText of [undefined, '', '  ']) {
    const { result } = await dispatchOcr('gotyme', {
      text: 'Original receipt', layoutText, confidence: 0.92, confidenceSource: 'native',
    }, ['reference']);
    assert.equal(result.text, 'Original receipt');
    assert.equal(result.originalText, 'Original receipt');
    assert.equal(result.layoutApplied, false);
    assert.equal(result.fallbackReason, 'google_missing_reference');
  }
});

test('all other receipt providers keep their original OCR ordering', async () => {
  for (const provider of ['gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'pnb', 'securitybank']) {
    const { result, observed } = await dispatchOcr(provider, {
      text: 'Original receipt', layoutText: 'Reordered receipt', confidence: 0.95, confidenceSource: 'native',
    });
    assert.equal(result.text, 'Original receipt', provider);
    assert.equal(result.originalText, 'Original receipt', provider);
    assert.equal(result.layoutApplied, false, provider);
    assert.deepEqual(observed, ['Original receipt']);
  }
});

test('both settlement paths and fallback audit preserve untouched Google OCR', () => {
  const auditBindings = [...edge.matchAll(/(?:p_raw_ocr_text|raw_ocr_text): ([^,\n]+)/g)];
  assert.equal(auditBindings.length, 3);
  for (const [, expression] of auditBindings) {
    assert.equal(vm.runInNewContext(expression, {
      ocrOriginalText: 'Google original', ocrText: 'Layout used for parsing',
    }), 'Google original');
  }
});
