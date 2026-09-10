const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const edge = fs.readFileSync(path.join(__dirname, 'supabase/functions/verify-gcash-receipt/index.ts'), 'utf8');
const start = edge.indexOf('    const sourceProviderMatch =');
const end = edge.indexOf('    const bookingCanAutoApprove =', start);
assert.ok(start > 0 && end > start, 'load the production evidence gate');
const evidenceGate = edge.slice(start, end) + '\ncleanEvidence;';
const gcashParser = fs.readFileSync(path.join(__dirname, 'supabase/functions/_shared/gcash-receipt.ts'), 'utf8');
const recipientPolicyStart = gcashParser.indexOf('export function isGcashRecipientAccepted(');
const recipientPolicyEnd = gcashParser.indexOf('export function parseGcashReceipt(', recipientPolicyStart);
assert.ok(recipientPolicyStart > 0 && recipientPolicyEnd > recipientPolicyStart, 'load the production GCash recipient policy');
const isGcashRecipientAccepted = vm.runInNewContext(stripTypeScriptTypes(
  gcashParser.slice(recipientPolicyStart, recipientPolicyEnd).replace('export function', 'function'),
) + '\nisGcashRecipientAccepted;');

function verifyGate(provider = 'gotyme', comparison = {}, overrides = {}) {
  return vm.runInNewContext(evidenceGate, {
    isGcashRecipientAccepted,
    providerContext: { gotymeRecipientPolicy: 'name_and_account' },
    providerParse: {
      provider,
      receipt: {
        indicators: { providerBrand: true, competingProviderBrand: null, classification: provider === 'gcash' ? 'gcash' : undefined },
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

test('GCash workflow accepts masked recipient identity only with a matching visible name', () => {
  for (const name of ['exact', 'masked_compatible']) {
    assert.equal(verifyGate('gcash', { phone: 'last4_only', name }), true, name);
  }
  for (const name of ['mismatch', 'missing', 'not_configured', 'inconclusive']) {
    assert.equal(verifyGate('gcash', { phone: 'last4_only', name }), false, name);
  }
  assert.equal(verifyGate('gcash', { phone: 'exact', name: 'exact' }), true);
  assert.equal(verifyGate('gcash', { phone: 'exact', name: 'mismatch' }), false);
  assert.equal(verifyGate('gcash', { phone: 'mismatch', name: 'exact' }), false);
  assert.equal(verifyGate('gcash', { phone: 'missing', name: 'exact' }), false);
});

test('GCash masked-recipient approval retains every other evidence gate', () => {
  const matched = { phone: 'last4_only', name: 'masked_compatible' };
  assert.equal(verifyGate('gcash', matched, { extractedAmount: 260 }), false);
  assert.equal(verifyGate('gcash', matched, { duplicateClear: false }), false);
  assert.equal(verifyGate('gcash', matched, { extractedRef: null }), false);
  for (const flag of ['LOW_OCR_CONFIDENCE', 'REF_MISMATCH', 'AMOUNT_CONFIRMATION_UNREADABLE', 'TIME_EXPIRED', 'METHOD_MISMATCH', 'DUPLICATE_REF']) {
    assert.equal(verifyGate('gcash', matched, { flags: [flag] }), false, flag);
  }
});

test('configured QR destination token is supplied to both bank parsers and recorded in the audit', () => {
  for (const property of ['expectedRecipientAccount', 'expectedReceiverAccount']) {
    const accountExpression = edge.match(new RegExp(`${property}:\\s*(provider === "bdopay"[\\s\\S]*?)\\n\\s*: (?:""|null),`));
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

test('saved bank receipt evidence carries its provider so the admin panel shows the matching payment route', () => {
  const auditExpression = edge.match(/bankTransfer:\s*([\s\S]+?),\s*ocrProvider,/);
  assert.ok(auditExpression, 'load the production bank receipt audit');
  const admin = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  const adminStart = admin.indexOf('  const bankReceiptProvider =');
  const adminEnd = admin.indexOf('  const bankUsesQrAccount =', adminStart);
  assert.ok(adminStart > 0 && adminEnd > adminStart, 'load the production bank receipt display gate');
  const displayGate = admin.slice(adminStart, adminEnd) + '\nshowBankReceipt;';
  for (const provider of ['gotyme', 'maribank']) {
    const bankTransfer = vm.runInNewContext(auditExpression[1], {
      providerParse: { provider },
      bankParse: {
        reference: { value: 'SAVED-REFERENCE' },
        amount: { amount: 265, reliable: true, ambiguous: false },
        recipient: { accountVisibility: 'masked', accountSuffix: '9WO7' },
      },
      providerVerification: { provider, recipientComparison: { account: 'suffix_only' } },
      recipientRefinement: null,
    });
    assert.equal(bankTransfer.provider, provider);
    assert.equal(bankTransfer.reference.value, 'SAVED-REFERENCE');
    const ex = { provider, parserVersion: `${provider}_to_gcash_v1` };
    assert.equal(vm.runInNewContext(displayGate, { ex, bankTransfer }), true, provider);
    assert.equal(vm.runInNewContext(displayGate, {
      ex, bankTransfer: { ...bankTransfer, provider: 'gcash' },
    }), false, 'mismatched audit must not show another provider route');
    const legacyAudit = { ...bankTransfer };
    delete legacyAudit.provider;
    assert.equal(vm.runInNewContext(displayGate, { ex, bankTransfer: legacyAudit }), true,
      'existing audit uses its matching top-level provider and dedicated parser');
    for (const mismatch of [
      { ...ex, provider: undefined },
      { ...ex, provider: 'gcash' },
      { ...ex, parserVersion: provider === 'gotyme' ? 'maribank_to_gcash_v1' : 'gotyme_to_gcash_v1' },
    ]) {
      assert.equal(vm.runInNewContext(displayGate, { ex: mismatch, bankTransfer: legacyAudit }), false,
        'legacy audit still requires matching provider and parser identity');
    }
  }
});

const ocrStart = edge.indexOf('async function runOCR(');
const ocrEnd = edge.indexOf('\nfunction telegramAdminUrl(', ocrStart);
assert.ok(ocrStart > 0 && ocrEnd > ocrStart, 'load the production OCR dispatcher');
const ocrDispatcher = edge.slice(ocrStart, ocrEnd)
  .replace(/async function runOCR\([\s\S]*?\): Promise<OcrResult>/, 'async function runOCR(visionKey, base64, provider, typedRef, ocr = googleVisionOcr)')
  .replace(/\(e as \{ requestMetrics\?: GoogleVisionRequestMetrics \}\)/g, 'e');

async function dispatchOcr(provider, visionResult, gaps = []) {
  const observed = [];
  const run = vm.runInNewContext(ocrDispatcher + '\nrunOCR;', {
    googleVisionOcr: async () => visionResult,
    isBankAdaptiveProvider: provider => ['bdopay','maya','bpi','gotyme','maribank','securitybank'].includes(provider),
    bankOcrText: read => read.layoutText || read.nativeLines?.map(line => line.text).join('\n') || read.text,
    recoverGcashReferenceText: layoutText => layoutText,
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

test('GCash uses its validated payment layout and keeps the original page score for audit', async () => {
  const original = 'Amount\nTotal Amount Sent\n1,590.00\n₱1,590.00';
  const layout = 'Amount 1,590.00\nTotal Amount Sent ₱1,590.00';
  const gcashEvidence = { layoutText: layout, fields: {}, confidenceSource: 'none' };
  const { result, observed } = await dispatchOcr('gcash', {
    text: original, gcashEvidence, confidence: 0.8829, confidenceSource: 'native',
  });
  assert.equal(result.text, layout);
  assert.equal(result.originalText, original);
  assert.equal(result.layoutApplied, true);
  assert.equal(result.confidence, 0.8829);
  assert.equal(result.gcashEvidence, gcashEvidence);
  assert.deepEqual(observed, [layout]);
});

test('providers without an applicable dedicated layout keep their original OCR ordering', async () => {
  for (const provider of ['gcash', 'pnb']) {
    const { result, observed } = await dispatchOcr(provider, {
      text: 'Original receipt', layoutText: 'Reordered receipt', confidence: 0.95, confidenceSource: 'native',
    });
    assert.equal(result.text, 'Original receipt', provider);
    assert.equal(result.originalText, 'Original receipt', provider);
    assert.equal(result.layoutApplied, false, provider);
    assert.deepEqual(observed, ['Original receipt']);
  }
});

test('all dedicated banks use validated rows immediately and preserve the untouched original', async () => {
  for (const provider of ['bdopay','maya','bpi','gotyme','maribank','securitybank']) {
    const { result, observed } = await dispatchOcr(provider, {
      text: 'Amount\nFee\n265.00\n10.00', layoutText: 'Amount 265.00\nFee 10.00',
      confidence:.91, confidenceSource:'native',
    });
    assert.equal(result.text,'Amount 265.00\nFee 10.00');
    assert.equal(result.originalText,'Amount\nFee\n265.00\n10.00');
    assert.deepEqual(observed,['Amount 265.00\nFee 10.00']);
    assert.equal(result.confidence,.91);
    const fallback=await dispatchOcr(provider,{text:'Original receipt',confidence:.91,confidenceSource:'native'});
    assert.equal(fallback.result.text,'Original receipt');
    assert.equal(fallback.result.layoutApplied,false);
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

function reverifyHelpers() {
  const start = edge.indexOf('function isOwnerReverificationRequest(');
  const end = edge.indexOf('\nfunction receiptMetadataKey(', start);
  assert.ok(start > 0 && end > start);
  const source = edge.slice(start, end)
    .replace(/function isOwnerReverificationRequest\([\s\S]*?\): boolean/, 'function isOwnerReverificationRequest(body, hasUpload)')
    .replace(/function canReverifyBookingReceipt\([\s\S]*?\): boolean/, 'function canReverifyBookingReceipt(caller, row, body)');
  return vm.runInNewContext(source + '\n({ isOwnerReverificationRequest, canReverifyBookingReceipt });', {
    activeReceiptRole: account => account?.status === 'active' ? String(account.role || '').toLowerCase() : '',
  });
}

const reverifyRequest = {
  action: 'reverify', bookingRef: 'REVIEW-TEST',
  stagedReceiptPath: `REVIEW-TEST/${'a'.repeat(64)}.png`,
  expectedReceiptHash: 'a'.repeat(64),
  expectedReceiptVerifiedAt: '2026-09-09T06:00:00.000Z',
};
const reviewedBooking = {
  payment_method: 'gotyme', status: 'pending', payment_status: 'for_verification',
  receipt_status: 'manual_review', receipt_image_hash: reverifyRequest.expectedReceiptHash,
  receipt_image_url: reverifyRequest.stagedReceiptPath,
  receipt_verified_at: reverifyRequest.expectedReceiptVerifiedAt,
  receipt_flags: ['RECEIVER_ACCOUNT_MISMATCH'], receipt_extracted: { amount: 265 },
};

test('owner rechecks require an exact stored checkpoint and reject new evidence or booking changes', () => {
  const { isOwnerReverificationRequest } = reverifyHelpers();
  assert.equal(isOwnerReverificationRequest(reverifyRequest, false), true);
  assert.equal(isOwnerReverificationRequest({ ...reverifyRequest, expectedReceiptVerifiedAt: null }, false), true);
  assert.equal(isOwnerReverificationRequest(reverifyRequest, true), false, 'uploaded multipart image');
  for (const forbidden of ['imageBase64', 'imageFile', 'bookingData', 'bookingAccessToken', 'created_at', 'paymentMethod']) {
    assert.equal(isOwnerReverificationRequest({ ...reverifyRequest, [forbidden]: 'untrusted' }, false), false, forbidden);
  }
  for (const overrides of [
    { expectedReceiptHash: '' }, { expectedReceiptHash: 'z'.repeat(64) },
    { expectedReceiptVerifiedAt: undefined }, { expectedReceiptVerifiedAt: 'invalid' },
    { stagedReceiptPath: '' }, { provider: 'gcash' },
  ]) assert.equal(isOwnerReverificationRequest({ ...reverifyRequest, ...overrides }, false), false);
  const missingTime = { ...reverifyRequest };
  delete missingTime.expectedReceiptVerifiedAt;
  assert.equal(isOwnerReverificationRequest(missingTime, false), false, 'missing timestamp expectation');
});

test('only active owners can recheck a pending GoTyme receipt', () => {
  const { canReverifyBookingReceipt } = reverifyHelpers();
  for (const role of ['owner', 'court_owner']) {
    assert.equal(canReverifyBookingReceipt({ account: { role, status: 'active' } }, reviewedBooking, reverifyRequest), true, role);
    assert.equal(canReverifyBookingReceipt({ account: { role, status: 'inactive' } }, reviewedBooking, reverifyRequest), false, `inactive ${role}`);
  }
  for (const role of ['staff', 'host', 'customer', 'anon', 'service_role']) {
    assert.equal(canReverifyBookingReceipt({ account: { role, status: 'active' } }, reviewedBooking, reverifyRequest), false, role);
  }
  assert.equal(canReverifyBookingReceipt(null, reviewedBooking, reverifyRequest), false);
});

test('reverification refuses terminal bookings, stale snapshots, and changed methods or receipts', () => {
  const { canReverifyBookingReceipt } = reverifyHelpers();
  const owner = { account: { role: 'owner', status: 'active' } };
  for (const changed of [
    ...['confirmed', 'cancelled', 'completed', 'forfeited', 'verifying'].map(status => ({ status })),
    ...['paid', 'downpayment_paid', 'deposit_retained', 'rejected', 'unpaid'].map(payment_status => ({ payment_status })),
    { payment_method: 'gcash' }, { receipt_status: 'auto_approved' },
    { receipt_image_hash: 'b'.repeat(64) }, { receipt_image_url: 'ANOTHER/receipt.png' },
    { receipt_verified_at: '2026-09-09T06:01:00.000Z' }, { receipt_verified_at: null },
  ]) assert.equal(canReverifyBookingReceipt(owner, { ...reviewedBooking, ...changed }, reverifyRequest), false, JSON.stringify(changed));
});

test('reverification rechecks the complete group after claiming its lease and preserves old evidence until finalization', () => {
  assert.match(edge, /currentGroup\.every\(\(row\) =>\s*canReverifyBookingReceipt\(caller, row, body\)\s*\)/);
  assert.match(edge, /String\(booking\.booking_group_ref \|\| bookingRef\) !== receiptLeaseKey/);
  assert.match(edge, /if \(hasPersistedBooking && !isReverification\) \{\s*let safeStateQuery = bookingUpdateQuery/);
  const cachedGate = 'terminalAfterLease || (receiptEvidenceWasVerified(booking) && !isReverification)';
  assert.ok(edge.replace(/\s/g, '').includes(cachedGate.replace(/\s/g, '')));
  const runGate = change => vm.runInNewContext(cachedGate, {
    terminalAfterLease: false, receiptEvidenceWasVerified: () => true,
    booking: reviewedBooking, isReverification: false, ...change,
  });
  assert.equal(runGate({}), true, 'ordinary requests keep the cached result');
  assert.equal(runGate({ isReverification: true }), false, 'authorized rechecks can continue');
  assert.equal(runGate({ isReverification: true, terminalAfterLease: true }), true, 'terminal state never bypassed');
  assert.match(edge.replace(/\s+/g, ' '), /if \(\s*result === "manual_review" && hasPersistedBooking && !isReverification\s*\)/,
    'unchanged manual review does not send another review notification');
});
