const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');

function readingHistoryRows(booking) {
  const admin = read('admin.html');
  const source = admin.slice(admin.indexOf('function receiptReadingHistoryRows('), admin.indexOf('function receiptDetailsHtml('));
  return new Function('receiptDetailValue', `${source}; return receiptReadingHistoryRows;`)(String)(booking);
}

function receiptReviewUi() {
  const vm = require('node:vm');
  const admin = read('admin.html');
  const source = admin.slice(admin.indexOf('const RECEIPT_FLAG_LABELS ='), admin.indexOf('function bookingSourceLabel('));
  return vm.runInNewContext(source + '\n({bankReceiptAccountDisplay,receiptFlagsForDisplay,receiptFlagLabel,receiptReasonText,receiptFlagChips,receiptDetailsHtml});', {
    esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    fmt: value => `₱${value}`,
  });
}

function uncertainAccountBooking() {
  return {paymentMethod:'gotyme',receiptStatus:'manual_review',paymentStatus:'for_verification',status:'pending',
    receiptFlags:['NUMBER_UNREADABLE','RECEIVER_ACCOUNT_MISMATCH','LOW_OCR_CONFIDENCE'],
    receiptExtracted:{provider:'gotyme',parserVersion:'gotyme_to_gcash_v1',ocrConfidenceSource:'native',
      expectedReceiverAccount:'DWQM4TK3JDNZU9WO7',
      paymentFieldEvidence:{recipientAccount:{text:'***9W07',confidence:.85291046}},
      bankTransfer:{provider:'gotyme',recipient:{accountRaw:'***9W07',accountSuffix:'9W07',accountVisibility:'missing',phoneNormalized:null},
        recipientComparison:{account:'mismatch',phone:'missing',name:'masked_compatible'}},
    }};
}

test('GoTyme review explains actual low-confidence O/0 account evidence without changing the saved decision', () => {
  const ui=receiptReviewUi();
  const booking=uncertainAccountBooking();
  const before=JSON.stringify(booking);
  const html=ui.receiptDetailsHtml(booking);
  assert.match(html,/Recipient account character unclear \(O\/0\)/);
  assert.match(html,/Recipient Account OCR Confidence/);
  assert.match(html,/85\.29%/);
  assert.match(html,/\*\*\*9W07/);
  assert.doesNotMatch(html,/Number not read|Receiver number unreadable|Account not read|Auto-verified/);
  const chips=ui.receiptFlagChips(booking.receiptFlags,false,booking);
  assert.match(chips,/Recipient account character unclear \(O\/0\)/);
  assert.doesNotMatch(chips,/Account needs review|Receiver number unreadable/);
  assert.match(ui.receiptReasonText(booking.receiptFlags,booking),/OCR confidence below threshold/);
  assert.equal(JSON.stringify(booking),before,'display never changes stored flags, OCR values, or payment state');
});

test('GoTyme display removes only duplicate destination warnings and preserves saved review status', () => {
  const ui=receiptReviewUi();
  const booking=uncertainAccountBooking();
  booking.receiptFlags.push('RECEIVER_ACCOUNT_UNREADABLE','AMOUNT_MISMATCH');
  const before=JSON.stringify(booking);
  assert.deepEqual(Array.from(ui.receiptFlagsForDisplay(booking)),['RECEIVER_ACCOUNT_MISMATCH','LOW_OCR_CONFIDENCE','AMOUNT_MISMATCH']);
  const reason=ui.receiptReasonText(booking.receiptFlags,booking);
  assert.match(reason,/Recipient account character unclear \(O\/0\)/);
  assert.match(reason,/OCR confidence below threshold|Amount mismatch/);
  assert.doesNotMatch(reason,/Account needs review|Recipient account could not be read/);
  assert.equal(JSON.stringify(booking),before);
  const manuallyConfirmed=structuredClone(booking);
  manuallyConfirmed.paymentStatus='paid';manuallyConfirmed.status='confirmed';
  assert.doesNotMatch(ui.receiptDetailsHtml(manuallyConfirmed),/Character Check|Verified Account Ending|Destination matched by character check/);
  assert.equal(manuallyConfirmed.receiptStatus,'manual_review');

  const single=uncertainAccountBooking();single.receiptFlags=['NUMBER_UNREADABLE','LOW_OCR_CONFIDENCE'];
  assert.deepEqual(Array.from(ui.receiptFlagsForDisplay(single)),single.receiptFlags);
  assert.match(ui.receiptFlagChips(single.receiptFlags,false,single),/Account needs review/);
  const missing=uncertainAccountBooking();
  Object.assign(missing.receiptExtracted.bankTransfer.recipient,{accountRaw:null,accountSuffix:null});
  assert.deepEqual(Array.from(ui.receiptFlagsForDisplay(missing)),missing.receiptFlags,'genuinely missing account evidence must remain visible');
});

test('GoTyme saved name-only policy displays the configured masked-name check without hiding other failures', () => {
  const ui=receiptReviewUi();
  const booking=uncertainAccountBooking();
  Object.assign(booking.receiptExtracted,{recipientVerificationPolicy:'masked_name_only',expectedReceiverName:'KRISTIE LOU CACHUELA'});
  booking.receiptExtracted.bankTransfer.recipient.nameRaw='KR****E L** C*';
  booking.receiptFlags.push('AMOUNT_MISMATCH');
  const before=JSON.stringify(booking);
  const html=ui.receiptDetailsHtml(booking);
  assert.match(html,/Receiver Check[\s\S]*?Configured masked name matched/);
  assert.match(html,/Recipient Account Read[\s\S]*?\*\*\*9W07/,'observed account remains available for audit');
  assert.doesNotMatch(html,/Saved GCash QR Account Ending|character unclear \(O\/0\)|Account does not match|Auto-verified/);
  assert.match(html,/Configured Recipient[\s\S]*?KRISTIE LOU CACHUELA/);
  assert.doesNotMatch(html,/DWQM4TK3JDNZU9WO7/,'the optional destination account is not presented as the configured receiver gate');
  assert.deepEqual(Array.from(ui.receiptFlagsForDisplay(booking)),['LOW_OCR_CONFIDENCE','AMOUNT_MISMATCH']);
  assert.equal(JSON.stringify(booking),before);
  const mismatch=structuredClone(booking);
  mismatch.receiptExtracted.bankTransfer.recipientComparison.name='mismatch';
  mismatch.receiptFlags.push('RECEIVER_NAME_MISMATCH');
  assert.match(ui.receiptDetailsHtml(mismatch),/Configured masked name needs review/);
  assert.match(ui.receiptReasonText(mismatch.receiptFlags,mismatch),/Receiver name mismatch/);
  assert.deepEqual(Array.from(ui.receiptFlagsForDisplay(mismatch)),['RECEIVER_ACCOUNT_MISMATCH','LOW_OCR_CONFIDENCE','AMOUNT_MISMATCH','RECEIVER_NAME_MISMATCH']);
  const unsupported=structuredClone(booking);unsupported.receiptExtracted.recipientVerificationPolicy='unknown';
  assert.doesNotMatch(ui.receiptDetailsHtml(unsupported),/Configured masked name matched/);
  const missing=structuredClone(booking);missing.receiptExtracted.bankTransfer.recipient.nameRaw=null;
  assert.match(ui.receiptDetailsHtml(missing),/Configured masked name needs review/);
});

test('account ambiguity requires matching native field evidence and exactly one O/0 difference', () => {
  const ui=receiptReviewUi();
  for(const change of [
    ex=>{ex.paymentFieldEvidence.recipientAccount.confidence=.95;},
    ex=>{ex.paymentFieldEvidence.recipientAccount.confidence=null;},
    ex=>{ex.paymentFieldEvidence.recipientAccount.confidence='0.85';},
    ex=>{delete ex.paymentFieldEvidence;},
    ex=>{ex.ocrConfidenceSource='derived';},
    ex=>{ex.paymentFieldEvidence.recipientAccount.text='***9WO7';},
    ex=>{ex.expectedReceiverAccount='DWQM4TK3JDNZU8WO7';},
    ex=>{ex.expectedReceiverAccount='DWQM4TK3JDNZU9WA7';},
  ]) {
    const booking=uncertainAccountBooking();change(booking.receiptExtracted);
    assert.equal(ui.bankReceiptAccountDisplay(booking.receiptExtracted).characterUnclear,false);
    assert.equal(ui.receiptFlagLabel('RECEIVER_ACCOUNT_MISMATCH',booking),'Recipient account does not match');
    assert.doesNotMatch(ui.receiptDetailsHtml(booking),/character unclear \(O\/0\)/);
  }
});

test('observed bank accounts use account status while genuinely missing destinations remain visible', () => {
  const ui=receiptReviewUi();
  for(const provider of ['gotyme','maribank','maya','bdopay','bpi']) {
    const booking=uncertainAccountBooking();
    Object.assign(booking.receiptExtracted,{provider,parserVersion:`${provider}_to_gcash_v1`});
    booking.receiptExtracted.bankTransfer.provider=provider;
    booking.receiptExtracted.bankTransfer.recipientComparison.account='suffix_only';
    assert.match(ui.bankReceiptAccountDisplay(booking.receiptExtracted).label,/Visible account ending matches/);
    assert.doesNotMatch(ui.receiptDetailsHtml(booking),/Number not read/);
  }
  const missing=uncertainAccountBooking();
  Object.assign(missing.receiptExtracted.bankTransfer.recipient,{accountRaw:null,accountSuffix:null,accountNormalized:null});
  assert.equal(ui.bankReceiptAccountDisplay(missing.receiptExtracted),null);
  assert.equal(ui.receiptFlagLabel('NUMBER_UNREADABLE',missing),'Receiver number unreadable');
  assert.match(ui.receiptDetailsHtml(missing),/Number not read/);
  assert.doesNotMatch(ui.receiptDetailsHtml(missing),/Recipient Account OCR Confidence|character unclear \(O\/0\)/);
});

test('GCash layout-loss diagnostics distinguish a recovered OCR reference from an unreadable one', () => {
  const ui=receiptReviewUi();
  const layoutLoss={receiptExtracted:{provider:'gcash',ocrFallbackReason:'google_missing_reference',gcash:{reference:{value:null}}}};
  assert.equal(ui.receiptFlagLabel('REF_UNREADABLE',layoutLoss),'Reference unreadable or split across OCR lines');
  const ordinary={receiptExtracted:{provider:'gcash',ocrFallbackReason:null,gcash:{reference:{value:null}}}};
  assert.equal(ui.receiptFlagLabel('REF_UNREADABLE',ordinary),'Reference unreadable');
});

test('receipt reading history shows only saved attempts and keeps agreement separate from confidence', () => {
  assert.deepEqual(readingHistoryRows({}), [], 'legacy records do not invent a check time or readings');
  const rows = readingHistoryRows({receiptExtracted: {
    checkedAt: '2026-09-10T01:06:00.000Z',
    readingRecovery: {
      attempted: true, accepted: true, reason: 'consistent_readings',
      readings: [
        {strategy:'gcash_full_contrast_v1',outcome:'clean',confidence:0.932},
        {strategy:'gcash_full_enlarged_v1',outcome:'clean',confidence:0.947},
      ],
    },
    ocrMetrics: {calls:3,retries:1,durationMs:5500},
  }});
  const values = Object.fromEntries(rows.map(([label, value]) => [label, value]));
  assert.match(values['Saved Receipt Check'], /2026.*9:06.*AM.*PH/);
  assert.equal(values['Additional Reading'], 'Additional reading matched');
  assert.equal(values['Additional Reading Attempts'], '2');
  assert.equal(values['Additional OCR Confidence'], '93% / 95%');
  assert.equal(values['Automatic Service Retries'], '1');
  assert.doesNotMatch(JSON.stringify(rows), /100%|3\/3|proof of payment|learned/i);
  assert.match(read('admin.html'), /ex\.originalOcrConfidence \?\? ex\.ocrConfidence/);
});

test('GCash approval confidence shows the true boundary and weakest payment field', () => {
  const ui=receiptReviewUi();
  const booking={receiptStatus:'manual_review',paymentStatus:'for_verification',status:'pending',
    receiptFlags:['LOW_OCR_CONFIDENCE'],receiptExtracted:{provider:'gcash',
      originalOcrConfidence:.9565279,approvalConfidence:.8964695599999999,
      approvalConfidenceSource:'gcash_payment_fields',
      gcash:{receiver:{name:{raw:'KR....E L.. C.'}},recipientComparison:{phone:'exact',name:'masked_compatible'},
        indicators:{classification:'gcash'},ocrEvidence:{fields:{
          amount:{confidence:.98965883},totalAmount:{confidence:.9061786},
          reference:{confidence:.98979497},dateTime:{confidence:.98474344625},
          recipientPhone:{confidence:.9767577483333333},recipientName:{confidence:.8964695599999999},
        }}},
    }};
  const before=JSON.stringify(booking);
  const html=ui.receiptDetailsHtml(booking);
  assert.match(html,/Approval Confidence[\s\S]*?89\.65%/);
  assert.match(html,/Approval Requirement[\s\S]*?Below minimum 90\.00%/);
  assert.match(html,/Weakest field: Recipient name \(89\.65%\)/);
  assert.match(html,/GCash payment details/);
  assert.equal(JSON.stringify(booking),before,'confidence display cannot mutate review evidence');

  const near=structuredClone(booking);
  near.receiptExtracted.approvalConfidence=.89995;
  near.receiptExtracted.gcash.ocrEvidence.fields.recipientName.confidence=.89995;
  assert.match(ui.receiptDetailsHtml(near),/89\.9950%[\s\S]*?Below minimum 90\.00%/);
  const boundary=structuredClone(booking);
  boundary.receiptFlags=[];
  boundary.receiptExtracted.approvalConfidence=.9;
  boundary.receiptExtracted.gcash.ocrEvidence.fields.recipientName.confidence=.9;
  assert.match(ui.receiptDetailsHtml(boundary),/90\.00%[\s\S]*?Meets minimum 90\.00%/);
  const admin=read('admin.html');
  assert.doesNotMatch(admin,/approvalConfidenceNumber \* 100\)\}%/);
});

test('saved OCR service failures and conflicting readings have different owner explanations', () => {
  const service = readingHistoryRows({receiptExtracted:{readingRecovery:{
    attempted:true, accepted:false, reason:'transport_unavailable', readings:[{outcome:'error'}],
  }}});
  const conflict = readingHistoryRows({receiptExtracted:{readingRecovery:{
    attempted:true, accepted:false, reason:'readings_disagree', readings:[{outcome:'conflict',confidence:'99%'}],
  }}});
  assert.match(JSON.stringify(service), /service unavailable/);
  assert.match(JSON.stringify(conflict), /Readings did not agree/);
  assert.doesNotMatch(JSON.stringify(service), /OCR Confidence/);
  assert.doesNotMatch(JSON.stringify(conflict), /OCR Confidence|Additional reading matched/);
  assert.deepEqual(readingHistoryRows({receiptExtracted:{checkedAt:'invalid',readingRecovery:{attempted:false},ocrMetrics:{retries:-1}}}), []);
  const admin = read('admin.html');
  assert.match(admin, /OCR_UNAVAILABLE:'Receipt-checking service unavailable'/);
  assert.match(admin, /IMAGE_UNREADABLE:'Receipt text could not be read'/);
  assert.doesNotMatch(admin, /<button[^>]*>[\s\n]*Recheck Receipt/i);
});

test('bank reading history omits skipped views and reports native confidence honestly', () => {
  const rows = readingHistoryRows({receiptExtracted:{provider:'maya',readingRecovery:{
    attempted:true,accepted:true,reason:'consistent_readings',readings:[
      {strategy:'bank_full_contrast_v1',outcome:'clean',confidence:.92},
      {strategy:'bank_full_enlarged_v1',outcome:'clean',confidence:.94},
      {strategy:'unused',outcome:'skipped'},
    ],
  }}});
  const values=Object.fromEntries(rows.map(([label,value])=>[label,value]));
  assert.equal(values['Additional Reading Attempts'],'2');
  assert.equal(values['Additional OCR Confidence'],'92% / 94%');
  assert.equal(values['Additional Reading'],'Additional reading matched');
  assert.match(read('admin.html'), /bank_payment_fields: 'Payment details for this method'/);
});

test('dedicated Maya review keeps recipient and reference failures visible to staff', () => {
  const vm = require('node:vm');
  const admin = read('admin.html');
  const source = admin.slice(admin.indexOf('function removeReceiptFlags('), admin.indexOf('function receiptBadge('));
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const failures = ['WRONG_GCASH_NUMBER', 'NUMBER_UNREADABLE', 'RECEIVER_NAME_MISMATCH', 'REF_FORMAT_INVALID', 'TIME_EXPIRED', 'TIME_FUTURE'];
  const result = context.receiptFlagsForDisplay({
    paymentMethod: 'maya', gcashRef: 'B7942F55EC99', receiptFlags: failures,
    receiptExtracted: { parserVersion: 'maya_to_gcash_v1', receiptAgeMinutes: null },
  });
  assert.deepEqual(Array.from(result), failures);
});

test('admin releases decoded receipt images when review modals close', () => {
  const admin = read('admin.html');
  const previewCleanup = admin.slice(
    admin.indexOf('function clearAdminReceiptPreview'),
    admin.indexOf('let sess;'),
  );
  const bookingClose = admin.slice(
    admin.indexOf('function closeVerifyModal'),
    admin.indexOf('function verifyPaymentModalKeydown'),
  );
  const remittanceClose = admin.slice(
    admin.indexOf('function closeRemittanceModal'),
    admin.indexOf('function remittanceModalKeydown'),
  );

  assert.match(previewCleanup, /removeAttribute\('src'\)/);
  assert.match(previewCleanup, /removeAttribute\('href'\)/);
  assert.match(previewCleanup, /id === 'opVerifyModal'[\s\S]*?clearAdminReceiptPreview\('ov'\)/);
  assert.match(bookingClose, /clearAdminReceiptPreview\('vm'\)/);
  assert.match(admin, /async function openVerifyModal[\s\S]*?\+\+_vmOpenToken[\s\S]*?await getBookingGroupByRef[\s\S]*?openToken !== _vmOpenToken/);
  assert.match(admin, /async function openOpVerifyModal[\s\S]*?\+\+_ovOpenToken[\s\S]*?await DB\.getOpenPlayRegistrations[\s\S]*?openToken !== _ovOpenToken/);
  assert.match(admin, /async function openHostSessionVerifyModal[\s\S]*?\+\+_ovOpenToken[\s\S]*?await Promise\.all[\s\S]*?openToken !== _ovOpenToken/);
  assert.match(admin, /const loadToken = _vmReceiptLoadToken[\s\S]*?loadToken !== _vmReceiptLoadToken/);
  assert.match(admin, /const loadToken = _ovReceiptLoadToken[\s\S]*?loadToken !== _ovReceiptLoadToken/);
  assert.match(admin, /ov\.id==='opVerifyModal'\) closeModal\('opVerifyModal'\)/);
  assert.match(remittanceClose, /rmReviewReceiptWrap[\s\S]*?removeAttribute\('src'\)/);
  assert.match(remittanceClose, /rmDetailBody[\s\S]*?removeAttribute\('src'\)/);
});

test('application no longer loads or requires Cloudflare Turnstile', () => {
  const productionFiles = [
    '.env.example',
    '_headers',
    'deploy-cloudflare-pages.ps1',
    'deploy-edge-functions.ps1',
    'host.html',
    'index.html',
    'supabase-config.js',
    'supabase/functions/host-application/index.ts',
    'supabase/functions/integration-status/index.ts',
    'supabase/functions/submit-public-booking/index.ts',
    'supabase/functions/submit-public-registration/index.ts',
    'supabase/functions/verify-gcash-receipt/index.ts',
  ];

  for (const path of productionFiles) {
    assert.doesNotMatch(read(path), /turnstile|challenges\.cloudflare\.com/i, path);
  }
  assert.equal(fs.existsSync('runtime-config.js'), false);
  assert.equal(fs.existsSync('supabase/functions/_shared/turnstile.ts'), false);
});

test('public receipt OCR flows share the canonical client verifier', () => {
  const page = read('index.html');

  assert.ok(
    (page.match(/DB\.verifyGcashReceipt\(/g) || []).length >= 3,
    'booking, Open Play, and host-session OCR must share the same client',
  );
});

test('receipt verification preserves authorization, resource, and settlement boundaries', () => {
  const edge = read('supabase/functions/verify-gcash-receipt/index.ts');
  const parser = read('supabase/functions/_shared/gcash-receipt.ts');
  const providerRegistry = read('supabase/functions/_shared/receipt-providers/index.ts');
  const gotymeParser = read('supabase/functions/_shared/receipt-providers/gotyme.ts');
  const maribankParser = read('supabase/functions/_shared/receipt-providers/maribank.ts');
  const finalizer = read(
    'supabase/migrations/20260901090000_receipt_review_maribank.sql'
  );
  const verifyStart = edge.indexOf('// ── verify a freshly-uploaded receipt');
  const storage = edge.indexOf('db.storage.from("receipts").upload', verifyStart);
  const vision = edge.indexOf('const ocr = await runOCR');
  const dimensionGate = edge.indexOf('if (!receiptImageSafeToDecode(bytes, contentType))');
  const imageDecode = edge.indexOf('Image.decode(bytes)');
  const persistedBranch = edge.indexOf('if (persistedRow) {', verifyStart);
  const persistedAuthorization = edge.indexOf(
    'canViewBookingReceipt(caller.account, caller.userId, booking)',
    persistedBranch,
  );
  const persistedDenial = edge.indexOf(
    'Receipt verification is not authorized for this booking',
    persistedAuthorization,
  );

  assert.ok(storage > 0 && vision > storage, 'receipt storage must complete before Google Vision runs');
  assert.ok(dimensionGate > 0 && imageDecode > dimensionGate, 'pixel dimensions must be capped before Image.decode');
  assert.ok(
    persistedBranch > 0 && persistedAuthorization > persistedBranch &&
      persistedDenial > persistedAuthorization && storage > persistedDenial,
    'persisted receipt writes must be authorized before Storage or OCR',
  );

  // Dedicated provider parsers keep source-bank evidence separate while all
  // uncertain results stay advisory and automated checks never reject.
  assert.match(edge, /parseProviderReceipt\(provider,\s*ocrText,\s*\{\s*typedReference:\s*typedRef/);
  assert.match(parser, /export function parseGcashReceipt\(/);
  assert.match(providerRegistry, /case "gcash"[\s\S]*?parseGcashReceipt/);
  assert.match(
    providerRegistry,
    /!receipt\.amount\.matchingPrimaryAmountDisplays[\s\S]*?AMOUNT_CONFIRMATION_UNREADABLE/,
  );
  assert.match(
    edge,
    /parsed\.receipt\.amount\.conflictingPrimaryAmounts \|\|[\s\S]*?!parsed\.receipt\.amount\.matchingPrimaryAmountDisplays/,
  );
  assert.match(
    edge,
    /matchingPrimaryAmountDisplays:\s*gcashParse\.amount\.matchingPrimaryAmountDisplays/,
  );
  assert.match(providerRegistry, /case "gotyme"[\s\S]*?parseGotymeToGcashReceipt/);
  assert.match(providerRegistry, /case "maribank"[\s\S]*?parseMaribankToGcashReceipt/);
  assert.match(gotymeParser, /export function parseGotymeToGcashReceipt/);
  assert.match(gotymeParser, /export function verifyGotymeToGcashReceipt/);
  assert.match(maribankParser, /export function parseMaribankToGcashReceipt/);
  assert.match(maribankParser, /export function verifyMaribankToGcashReceipt/);
  assert.match(edge, /const PAYMENT_WINDOW_MINUTES = 15/);
  assert.match(edge, /minimumOcrConfidence = isDedicatedReceiptProvider\(provider\)[\s\S]*?\? 0\.9[\s\S]*?: 0\.55/);
  assert.match(edge, /isDedicatedReceiptProvider\(provider\)[\s\S]*?ocrConfidenceSource !== "native"/);
  assert.match(edge, /const cleanEvidence = !!providerVerification &&[\s\S]*?duplicateClear &&\s*flags\.length === 0/);
  assert.match(edge, /let result: "auto_approved" \| "manual_review" =/);
  assert.match(edge, /bookingCanAutoApprove \|\| hostBalanceCanAutoApprove[\s\S]*?\? "auto_approved"[\s\S]*?: "manual_review"/);
  assert.doesNotMatch(edge, /let result: "auto_approved" \| "manual_review" \| "rejected"/);
  assert.match(
    edge,
    /result === "manual_review"[\s\S]*?statusUpdate\.status = "pending";[\s\S]*?statusUpdate\.payment_status = "for_verification"/
  );

  // Automatic settlement is delegated to one service-role-only transaction;
  // the browser and the Edge Function never claim the ledger piecemeal.
  assert.match(edge, /db\.rpc\(\s*"finalize_digital_receipt_auto_approval"/);
  assert.match(finalizer, /language plpgsql\s+security definer\s+set search_path = public, pg_temp/i);
  assert.match(
    finalizer,
    /revoke all on function public\.finalize_digital_receipt_auto_approval\([\s\S]*?\)\s+from public, anon, authenticated/i
  );
  assert.match(
    finalizer,
    /grant execute on function public\.finalize_digital_receipt_auto_approval\([\s\S]*?\)\s+to service_role/i
  );
});

test('GoTyme and MariBank use dedicated source methods with the shared GCash destination', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  const client = read('supabase-config.js');

  assert.match(page, /id="payOptGotyme"[\s\S]*?GoTyme → GCash/);
  assert.match(page, /id="payOptMaribank"[\s\S]*?MariBank → GCash/);
  assert.match(page, /\['bdopay', 'maya', 'bpi', 'gotyme', 'maribank'\][\s\S]*?\? 'gcash'/);
  assert.match(page, /payment_method_maribank === '1' && receiverReady\('maribank'\)/);
  assert.doesNotMatch(page, /id="gotymeBox"|id="gotymeQrPlaceholder"/);

  assert.match(admin, /id="payMethodGotymeOn"[\s\S]{0,500}?GoTyme → GCash/);
  assert.match(admin, /id="payMethodMaribankOn"[\s\S]{0,500}?MariBank → GCash/);
  assert.match(admin, /saveSetting\('payment_method_maribank'/);
  assert.doesNotMatch(admin, /id="gotymeNumInput"|id="gotymeNameInput"|saveSetting\('gotyme_merchant_/);

  assert.match(client, /PB_DIGITAL_PAYMENT_METHODS = \['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb', 'securitybank'\]/);
  assert.match(client, /payment_method_gotyme: '1'/);
  assert.match(client, /payment_method_maribank: '1'/);
});

test('automated uncertainty queues owner review while owners retain both deliberate decisions', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  const client = read('supabase-config.js');
  const hostSessionVerifier = page.slice(
    page.indexOf('async function verifyHostSessionReceipt'),
    page.indexOf('async function submitHostSessionJoin'),
  );
  const openPlayVerifier = page.slice(
    page.indexOf('async function verifyOpReceipt'),
    page.indexOf('async function submitOpenPlay'),
  );
  const receiptDisclosure = page.match(/<[^>]+id="bookingReceiptDisclosure"[^>]*>[\s\S]*?<\/p>/)?.[0] || '';

  assert.match(client, /function _pbNormalizeReceiptOutcome[\s\S]*?status: 'manual_review'/);
  assert.match(client, /if \(String\(source\.status \|\| ''\)\.toLowerCase\(\) === 'auto_approved'\) return source/);
  assert.doesNotMatch(hostSessionVerifier, /status === 'rejected'|status: 'rejected'/);
  assert.doesNotMatch(openPlayVerifier, /status === 'rejected'|status: 'rejected'/);
  assert.match(admin, /id="vmRejectBtn"[\s\S]*?❌ Not Received/);
  assert.match(admin, /id="vmConfirmBtn"[\s\S]*?✅ Received — Confirm/);
  assert.match(admin, /function canManuallyResolvePayment\(\)[\s\S]*?\['owner', 'court_owner'\]/);
  assert.match(admin, /id="bookingPaymentRejectReason"[^>]*required[^>]*minlength="3"[^>]*maxlength="1000"[^>]*aria-describedby/);
  assert.match(admin, /DB\.rejectBookingPaymentTransaction\(canonicalRef, reason\)/);
  assert.match(admin, /DB\.sendBookingStatusEmail\(canonicalRef, 'payment_rejected', reason, \{ allowFailure: true \}\)/);
  assert.match(admin, /result\?\.transitioned === false[\s\S]*?No duplicate email was sent/);
  assert.match(admin, /bookingPaymentRejectDialog[^>]*aria-busy="false"/);
  assert.match(admin, /setBookingPaymentRejectBusy\(true\)/);
  assert.match(admin, /suspendedVerify[\s\S]*?verifyOverlay\.inert = true[\s\S]*?aria-hidden', 'true'/);
  const rejectFlow = admin.slice(
    admin.indexOf('async function confirmBookingPaymentRejection'),
    admin.indexOf('async function rejectPayment'),
  );
  const transactionAt = rejectFlow.indexOf('DB.rejectBookingPaymentTransaction');
  const emailAt = rejectFlow.indexOf('DB.sendBookingStatusEmail');
  const refreshAt = rejectFlow.indexOf('refreshBookingPaymentRejectionViews', emailAt);
  assert.ok(transactionAt >= 0 && emailAt > transactionAt, 'email must follow the committed rejection');
  assert.ok(refreshAt > emailAt, 'nonessential UI refresh must not be able to skip the rejection email');
  assert.match(admin, /Promise\.allSettled\(refreshes\)/);
  assert.doesNotMatch(
    admin.slice(admin.indexOf('async function confirmBookingPaymentRejection'), admin.indexOf('async function delBooking')),
    /updateBookingGroupByRef/,
  );
  assert.match(client, /async rejectBookingPaymentTransaction\(ref, reason\)[\s\S]*?\.rpc\('reject_booking_payment_transaction'/);
  assert.ok((client.match(/receiptVerificationId: Number\(reg\.receiptVerificationId\) \|\| null/g) || []).length >= 2);
  assert.doesNotMatch(admin, /Request clearer proof|Request Clearer Proof/i);
  assert.match(receiptDisclosure, /href="receipt-verification\.html"/);
  const receiptDetails = read('receipt-verification.html');
  assert.match(receiptDetails, /a complete, matching receipt can confirm your payment automatically/);
  assert.match(receiptDetails, /Unclear or mismatched details stay pending for the court owner to review/);
  assert.doesNotMatch(page, /invalid payment may release this reservation/i);
  assert.doesNotMatch(page, /receipt[^\n]*(?:automatically|automatic)[^\n]*(?:reject|cancel|release)/i);
  assert.doesNotMatch(receiptDetails, /receipt[^\n]*(?:automatically|automatic)[^\n]*(?:reject|cancel|release)/i);
});

test('duplicate-payment resolver requires an exact preview and an explicit no-refund decision', () => {
  const admin = read('admin.html');
  assert.match(admin, /id="bookingPaymentTransferModal"[^>]*aria-hidden="true"[^>]*inert[^>]*hidden/);
  assert.match(admin, /id="bookingPaymentTransferDialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="bookingPaymentTransferTitle"[^>]*aria-describedby=/);
  assert.match(admin, /id="bookingPaymentTransferReason"[^>]*required[^>]*minlength="10"[^>]*maxlength="1000"[^>]*aria-describedby=/);
  assert.match(admin, /<input[^>]*type="checkbox"[^>]*id="bookingPaymentTransferNoRefund"/);
  assert.match(admin, /id="bookingPaymentTransferConfirm"[^>]*disabled[^>]*onclick="confirmBookingPaymentTransfer\(\)"/);
  assert.match(admin, /Old booking[\s\S]*?Cancelled[\s\S]*?New booking[\s\S]*?Awaiting review/);
  assert.match(admin, /The old booking stays cancelled[\s\S]*?does not charge or refund the player/);

  const eligibilityStart = admin.indexOf('function bookingGroupHasAcceptedPaymentEvidence');
  const eligibilityEnd = admin.indexOf('\nfunction bookingDuplicateTransferButton', eligibilityStart);
  assert.ok(eligibilityStart >= 0 && eligibilityEnd > eligibilityStart, 'missing duplicate-transfer preview helpers');
  const eligibilitySource = admin.slice(eligibilityStart, eligibilityEnd);
  const build = canResolve => new Function(
    'canManuallyResolvePayment',
    'bookingGroupRowsForPaymentGuard',
    'hostBalancePendingPayment',
    'isDigitalPayment',
    'normalizedPaymentRefKey',
    `${eligibilitySource}; return { cancelledDuplicatePaymentSource, bookingPaymentTransferPreview };`,
  )(
    () => canResolve,
    group => group?.allItems || group?.items || (group ? [group] : []),
    () => false,
    method => ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'].includes(String(method || '').toLowerCase()),
    group => `${String(group?.paymentMethod || '').toLowerCase()}:${String(group?.gcashRef || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
  );
  const row = {
    fullName: 'Same Player', email: 'player@example.com', contactNumber: '0917 555 0101',
    hostBooking: true, hostUserId: 'host-1', paymentMethod: 'maya', gcashRef: '9F34 952D 6576',
    total: 4800, downpayment: 1290, receiptStatus: 'manual_review',
    receiptImageUrl: 'private/receipt.png', receiptImageHash: 'same-hash', receiptPhash: 'same-phash',
    paidAt: '2026-09-02T23:08:34.000Z', bookingFeeEarnedAt: '2026-09-02T23:08:34.000Z',
  };
  const source = {
    ...row, ref: 'OLD-1', status: 'cancelled', paymentStatus: 'downpayment_paid',
    allItems: [{ ...row, ref: 'OLD-1', status: 'cancelled', paymentStatus: 'downpayment_paid' }],
  };
  const target = {
    ...row, ref: 'NEW-1', status: 'pending', paymentStatus: 'for_verification',
    allItems: [{ ...row, ref: 'NEW-1', status: 'pending', paymentStatus: 'for_verification' }],
    duplicatePaymentGroups: [source],
  };
  const allowed = build(true);
  assert.equal(allowed.cancelledDuplicatePaymentSource(target), source);
  assert.equal(allowed.bookingPaymentTransferPreview(source, target).eligible, true);
  const legacyAcceptedSource = {
    ...source,
    paymentStatus: 'unpaid',
    allItems: source.allItems.map(item => ({ ...item, paymentStatus: 'unpaid' })),
  };
  assert.equal(
    allowed.cancelledDuplicatePaymentSource({ ...target, duplicatePaymentGroups: [legacyAcceptedSource] }),
    legacyAcceptedSource,
    'a legacy cancelled/unpaid source remains eligible only with durable acceptance evidence',
  );
  const reviewOnlySource = {
    ...source,
    paymentStatus: 'for_verification',
    allItems: source.allItems.map(item => ({ ...item, paymentStatus: 'for_verification' })),
  };
  assert.equal(
    allowed.cancelledDuplicatePaymentSource({ ...target, duplicatePaymentGroups: [reviewOnlySource] }),
    null,
    'a source that is merely For Verification is never accepted, even when stale timestamps exist',
  );
  assert.equal(allowed.bookingPaymentTransferPreview(reviewOnlySource, target).eligible, false);
  const missingAcceptanceTimestamp = {
    ...source,
    allItems: source.allItems.map(item => ({ ...item, bookingFeeEarnedAt: null })),
  };
  assert.equal(
    allowed.cancelledDuplicatePaymentSource({ ...target, duplicatePaymentGroups: [missingAcceptanceTimestamp] }),
    null,
    'every source row needs both durable acceptance timestamps',
  );
  assert.equal(build(false).cancelledDuplicatePaymentSource(target), null, 'non-review roles must never receive the action');
  assert.equal(allowed.cancelledDuplicatePaymentSource({ ...target, duplicatePaymentGroups: [source, { ...source, ref: 'OLD-2' }] }), null);
  assert.equal(allowed.cancelledDuplicatePaymentSource({ ...target, paymentStatus: 'unpaid', allItems: [{ ...target.allItems[0], paymentStatus: 'unpaid' }] }), null, 'server requires the target to remain For Verification');
  assert.equal(allowed.cancelledDuplicatePaymentSource({ ...target, duplicatePaymentGroups: [{ ...source, status: 'confirmed', allItems: [{ ...source.allItems[0], status: 'confirmed' }] }] }), null);
  assert.equal(allowed.bookingPaymentTransferPreview(source, {
    ...target,
    email: 'other@example.com',
    allItems: [{ ...target.allItems[0], email: 'other@example.com' }],
  }).eligible, false);
  assert.equal(allowed.bookingPaymentTransferPreview(source, { ...target, downpayment: 1200, allItems: [{ ...target.allItems[0], downpayment: 1200 }] }).eligible, false);
  assert.equal(allowed.bookingPaymentTransferPreview(source, {
    ...target,
    receiptImageHash: 'other-hash',
    receiptPhash: 'other-phash',
    allItems: [{ ...target.allItems[0], receiptImageHash: 'other-hash', receiptPhash: 'other-phash' }],
  }).eligible, false);
  const noStoredReceipt = {
    ...target,
    receiptImageUrl: '', receiptImageHash: '', receiptPhash: '', receiptStatus: 'none',
    allItems: [{ ...target.allItems[0], receiptImageUrl: '', receiptImageHash: '', receiptPhash: '', receiptStatus: 'none' }],
  };
  assert.equal(allowed.bookingPaymentTransferPreview(source, noStoredReceipt).eligible, false, 'a typed reference alone is not durable receipt evidence');
});

test('payment-transfer source badge displays the replacement group reference, not an internal child ref', () => {
  const admin = read('admin.html');
  assert.match(admin, /const displayRefByBookingRef = new Map\(\)[\s\S]*?paymentReassignedToDisplayRef:/);
  const badgeStart = admin.indexOf('function duplicatePaymentRefBadge');
  const badgeEnd = admin.indexOf('\nfunction receiptFlagChips', badgeStart);
  assert.ok(badgeStart >= 0 && badgeEnd > badgeStart, 'missing duplicate-payment badge helper');
  const badge = new Function(
    'esc',
    `${admin.slice(badgeStart, badgeEnd)}; return duplicatePaymentRefBadge;`,
  )(value => String(value));
  const html = badge({
    paymentReassignedToRef: 'PB-MTKD3YBQ-S7M2',
    paymentReassignedToDisplayRef: 'PB-MTKD3YBP-Z2HS',
  });
  assert.match(html, /PB-MTKD3YBP-Z2HS/);
  assert.doesNotMatch(html, /PB-MTKD3YBQ-S7M2/);

  const evidenceStart = admin.indexOf('function hostDepositEvidenceBadge');
  const evidenceEnd = admin.indexOf('\nfunction hostPaymentEvidenceHtml', evidenceStart);
  const evidenceBadge = new Function(
    `${admin.slice(evidenceStart, evidenceEnd)}; return hostDepositEvidenceBadge;`,
  )();
  const movedEvidence = evidenceBadge({
    hostBooking: true,
    paymentReassignedToRef: 'PB-MTKD3YBQ-S7M2',
    paymentStatus: 'unpaid',
    receiptStatus: 'manual_review',
    gcashRef: '9F34 952D 6576',
  });
  assert.match(movedEvidence, /Payment 1 moved/);
  assert.doesNotMatch(movedEvidence, /under review/);
});

test('duplicate-payment modal is accessible, revalidates, commits once, then emails from canonical state', () => {
  const admin = read('admin.html');
  const transferFlow = admin.slice(
    admin.indexOf('let _bookingPaymentTransferContext'),
    admin.indexOf('async function rejectPayment'),
  );
  assert.match(transferFlow, /globalThis\.crypto\?\.randomUUID|globalThis\.crypto\?\.getRandomValues/);
  assert.match(transferFlow, /idempotencyKey:\s*newBookingPaymentTransferIdempotencyKey\(\)/);
  assert.match(transferFlow, /freshBookingPaymentTransferGroups[\s\S]*?DB\.clearCache\?\.\(\['bookings'\]\)[\s\S]*?await DB\.getBookings\(\)/);
  assert.match(transferFlow, /function syncBookingPaymentTransferForm[\s\S]*?reason\.length < 10[\s\S]*?reason\.length > 1000[\s\S]*?!checked/);
  assert.match(transferFlow, /bookingPaymentTransferDialog'\)\?\.setAttribute\('aria-busy'/);
  assert.match(transferFlow, /bookingPaymentTransferClose','bookingPaymentTransferViewSource','bookingPaymentTransferCancel/);
  assert.match(transferFlow, /reason\.disabled = !!busy[\s\S]*?confirmation\.disabled = !!busy/);
  assert.match(transferFlow, /event\.key === 'Escape'[\s\S]*?closeBookingPaymentTransferModal\(\)/);
  assert.match(transferFlow, /event\.key !== 'Tab'[\s\S]*?event\.shiftKey[\s\S]*?last\.focus\(\)/);
  assert.match(transferFlow, /closeBookingPaymentTransferModal[\s\S]*?overlay\.inert = true[\s\S]*?overlay\.hidden = true/);
  assert.match(transferFlow, /context\?\.suspendedVerify[\s\S]*?verifyOverlay\.inert = false[\s\S]*?aria-hidden', 'false'/);
  assert.match(transferFlow, /restoreFocus[\s\S]*?previous\?\.isConnected[\s\S]*?previous\.focus\(\)/);
  assert.match(transferFlow, /suspendedVerify[\s\S]*?verifyOverlay\.inert = true[\s\S]*?aria-hidden', 'true'/);
  assert.match(transferFlow, /requestAnimationFrame\(\(\) => field\.focus\(\)\)/);

  const confirmStart = transferFlow.indexOf('async function confirmBookingPaymentTransfer');
  const confirmFlow = transferFlow.slice(confirmStart);
  assert.match(confirmFlow, /const groups = await freshBookingPaymentTransferGroups\(\)/);
  assert.match(confirmFlow, /String\(source\.primaryRef \|\| source\.ref\) !== String\(context\.sourceRef\)/);
  assert.match(confirmFlow, /const preview = bookingPaymentTransferPreview\(source, target\)[\s\S]*?!preview\.eligible/);
  assert.match(confirmFlow, /DB\.transferCancelledBookingPayment\([\s\S]*?context\.sourceRef,[\s\S]*?context\.targetRef,[\s\S]*?reason,[\s\S]*?true,[\s\S]*?context\.idempotencyKey/);
  assert.match(confirmFlow, /result\?\.transitioned === false[\s\S]*?No duplicate email was sent/);
  assert.doesNotMatch(confirmFlow, /\b(?:updateBooking|updateBookingGroupByRef|updatePaymentStatus)\s*\(/);

  const rpcAt = confirmFlow.indexOf('DB.transferCancelledBookingPayment');
  const emailAt = confirmFlow.indexOf("DB.sendBookingStatusEmail(canonicalTargetRef, 'payment_reassigned'");
  const refreshAt = confirmFlow.indexOf('refreshBookingPaymentTransferViews', emailAt);
  assert.ok(rpcAt >= 0 && emailAt > rpcAt, 'the canonical email must follow the committed transfer');
  assert.ok(refreshAt > emailAt, 'UI refresh failure must not be able to skip the transfer email');
  assert.match(confirmFlow, /transferCommitted = true/);
  assert.match(confirmFlow, /Payment moved and the new booking was confirmed, but the email could not be sent[\s\S]*?Resend Payment Move Email/);
  assert.match(confirmFlow, /if \(transferCommitted\)[\s\S]*?follow-up processing was interrupted/);
  assert.match(transferFlow, /Promise\.allSettled\(refreshes\)/);

  assert.match(transferFlow, /async function resendBookingPaymentTransferEmail/);
  assert.match(transferFlow, /bookingPaymentCanResendTransferEmail\(booking\)/);
  assert.match(transferFlow, /DB\.sendBookingStatusEmail\(canonicalRef, 'payment_reassigned', '', \{ allowFailure: true \}\)/);
  assert.match(admin, /function bookingPaymentCanResendTransferEmail[\s\S]*?paymentReassignedFromRef[\s\S]*?status[\s\S]*?=== 'confirmed'[\s\S]*?\['paid','downpayment_paid'\]/);
  assert.match(admin, /Resend Payment Move Email/);
  assert.match(admin, /id="vmResolveDuplicateBtn"[\s\S]*?>Resolve duplicate<\/button>/);
  assert.match(admin, /function bookingDuplicateTransferButton[\s\S]*?openBookingPaymentTransferModal/);
});

test('browser configuration does not expose server keys and CSP blocks frames', () => {
  const headers = read('_headers');

  if (fs.existsSync('runtime-config.js')) {
    const runtime = read('runtime-config.js');
    assert.doesNotMatch(runtime, /\b(?:serviceRole|secret|private)(?:Key|_KEY)\b/i);
  }
  assert.match(headers, /frame-src 'none'/);
});
