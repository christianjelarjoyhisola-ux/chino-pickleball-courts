const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const edge = fs.readFileSync('supabase/functions/verify-gcash-receipt/index.ts', 'utf8');
const start = edge.indexOf('    if (providerParse && providerParse.provider !== "gcash" && originalOcr &&');
const end = edge.indexOf('    if (\n      providerParse?.provider === "gotyme"', start);
const recoveryBlock = edge.slice(start, end > start ? end : edge.indexOf('    if (\r\n      providerParse?.provider === "gotyme"', start));
assert.ok(recoveryBlock.includes('recoverBankReceipt'), 'production recovery integration is loaded');

async function runRecovery(options = {}) {
  const calls = [];
  const provider = options.provider || 'maya';
  const context = {
    providerParse: {provider, destinationProvider: provider === 'securitybank' ? 'securitybank' : 'gcash', receipt:{}},
    originalOcr: {provider:'google_vision', text:'original', originalText:'original', confidence:.88, confidenceSource:'native'},
    providerContext: {expectedAmount:265},
    bankRead:null, originalBankCheck:null, bankReadingRecovery:null, gotymeFieldRecovery:null,
    flags:[], ocrError:null, visionKey:'test-key', pricingError:false,
    preferredReadingStrategy:undefined, readingLayout:'unknown',
    ocrText:'original', ocrLayoutApplied:false, ocrConfidence:.88,
    ocrConfidenceSource:'native', ocrFallbackReason:'google_missing_amount',
    bytes:new Uint8Array(), BANK_VERIFIER_REVISION:'bank_adaptive_20260910',
    readingSession:{remainingMs:()=>10000,ocr:()=>{}},
    isBankAdaptiveProvider:value=>['maya','bdopay','bpi','gotyme','maribank','securitybank'].includes(value),
    bankApprovalConfidence:()=>({confidence:.88,source:'bank_payment_fields'}),
    verifyProviderReceipt:()=>({flags:[]}),
    bankLayoutFamily:()=>options.layout || 'maya_sent_money_v1',
    bankOcrText:read=>read.layoutText || read.text,
    db:{rpc:(name,args)=>({abortSignal:async()=>{
      calls.push({type:'preference',name,args});
      if(options.preferenceFails) throw Error('unavailable');
      return {data:{strategy:'bank_full_enlarged_v1'},error:null};
    }})},
    recoverBankReceipt:async(_bytes,original,expected,_key,config)=>{
      calls.push({type:'recovery',original,expected,config});
      return options.recovery || {accepted:false,reason:'uncertain',audit:{readings:[]}};
    },
    recoverGotymeFields:async()=>options.fields || {accepted:false,reason:'recovery_incomplete',audit:{readings:[]}},
    AbortSignal,
    ...options.context,
  };
  const source = stripTypeScriptTypes(`(async function(){${recoveryBlock}})()`);
  await vm.runInNewContext(source, context);
  return {context,calls};
}

test('complete bank receipt stays on the original read without spending more OCR calls', async()=>{
  const {calls}=await runRecovery({context:{bankApprovalConfidence:()=>({confidence:.94,source:'bank_payment_fields'})}});
  assert.equal(calls.length,0);
});

test('recovery preserves raw original evidence and scopes preferences to provider and destination', async()=>{
  for(const provider of ['maya','bdopay','bpi','gotyme','maribank','securitybank']) {
    const {calls}=await runRecovery({provider});
    assert.equal(calls[0].args.p_provider,provider);
    assert.equal(calls[0].args.p_destination_provider,provider==='securitybank'?'securitybank':'gcash');
    assert.equal(calls[0].args.p_parser_revision,'bank_adaptive_20260910');
    assert.equal(calls[1].original.read.text,'original');
    assert.equal(calls[1].expected.expectedAmount,265);
    assert.equal(calls[1].config.deadlineMs,10000);
  }
});

test('accepted recovery uses its actual fields and confidence without rewriting original audit', async()=>{
  const selected={parsed:{provider:'maya',receipt:{reference:{value:'REAL-REF'}}},read:{text:'recovered',layoutText:'labelled recovered',confidence:.89,confidenceSource:'native'},approval:{confidence:.93,source:'bank_payment_fields'}};
  const {context}=await runRecovery({recovery:{accepted:true,selected,reason:'consistent_readings',audit:{readings:[{outcome:'clean'}]}}});
  assert.equal(context.ocrText,'labelled recovered');
  assert.equal(context.providerParse.receipt.reference.value,'REAL-REF');
  assert.equal(context.ocrConfidence,.89);
  assert.equal(context.originalOcr.text,'original');
  assert.equal(context.ocrFallbackReason,null);
});

test('conflicting originals and disagreeing recovery remain visible review flags', async()=>{
  for(const reason of ['original_conflict:ORIGINAL_REFERENCE_CONFLICT','recovery_conflict','recovery_readings_disagree']) {
    const {context}=await runRecovery({recovery:{accepted:false,reason,audit:{readings:[]}}});
    assert.ok(context.flags.includes('OCR_READINGS_DISAGREE'));
    assert.equal(context.ocrText,'original');
  }
});

test('failed preference lookup is optional, failed OCR is a separate review reason', async()=>{
  const {context,calls}=await runRecovery({preferenceFails:true,recovery:{accepted:false,reason:'transport_unavailable',audit:{readings:[{outcome:'error'}]}}});
  assert.equal(calls.length,2);
  assert.equal(calls[1].config.preferredStrategy,undefined);
  assert.ok(context.flags.includes('OCR_REREAD_UNAVAILABLE'));
  assert.ok(!context.flags.includes('OCR_READINGS_DISAGREE'));
});

test('configuration, primary OCR errors and exhausted budgets do not launch bank recovery',async()=>{
  for(const override of [{flags:['MERCHANT_CONFIG_MISSING']},{ocrError:'offline'},{pricingError:true},{visionKey:''},{readingSession:{remainingMs:()=>0}}]) {
    const {calls}=await runRecovery({context:override});
    assert.equal(calls.length,0);
  }
  for(const provider of ['pnb','gcash']) assert.equal((await runRecovery({provider})).calls.length,0);
});

test('unknown layouts never use another layout\'s learned preference',async()=>{
  const {calls}=await runRecovery({layout:'unknown'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].type,'recovery');
  assert.equal(calls[0].config.preferredStrategy,undefined);
});

test('bank approval keeps selected payment-field confidence distinct from original image score',()=>{
  const from=edge.indexOf('    const approval = provider === "gcash"');
  const to=edge.indexOf('    const minimumOcrConfidence',from);
  const context={provider:'maya',readingRecovery:null,gotymeFieldRecovery:null,gotymeNativeFusion:null,bankReadingRecovery:{accepted:true,selected:{approval:{confidence:.93,source:'bank_payment_fields'}}},ocrConfidence:.88,ocrConfidenceSource:'native'};
  vm.runInNewContext(edge.slice(from,to)+'\nthis.observed = {approvalConfidence,approvalConfidenceSource};',context);
  assert.equal(context.observed.approvalConfidence,.93);
  assert.equal(context.observed.approvalConfidenceSource,'bank_payment_fields');
});

test('GoTyme targeted recovery selects observed fields and stops further full-image reads',async()=>{
  const selected={parsed:{provider:'gotyme',receipt:{reference:{value:'OBSERVED'}}},read:{text:'original',layoutText:'observed panels',confidence:.88,confidenceSource:'native'},approval:{confidence:.93,source:'bank_payment_fields'}};
  const {context,calls}=await runRecovery({provider:'gotyme',fields:{accepted:true,selected,reason:'targeted_readings_agree',audit:{readings:[{outcome:'clean'}]}}});
  assert.equal(calls.length,0);
  assert.equal(context.providerParse.receipt.reference.value,'OBSERVED');
  assert.equal(context.ocrText,'observed panels');
  assert.equal(context.originalOcr.text,'original');
});

test('GoTyme targeted conflicts cannot be bypassed by the full-image fallback',async()=>{
  const {context,calls}=await runRecovery({provider:'gotyme',fields:{accepted:false,reason:'recovery_conflict',audit:{readings:[{outcome:'conflict'}]}}});
  assert.equal(calls.length,0);
  assert.ok(context.flags.includes('OCR_READINGS_DISAGREE'));
  assert.equal(context.ocrText,'original');
});

test('raw original adverse status remains a veto even when reconstructed rows omit it',()=>{
  const statusSource=stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/receipt-providers/transfer-status.ts','utf8').replace(/\bexport /g,''));
  const status=vm.runInNewContext(statusSource+'\nreadReceiptTransferStatus;');
  const from=edge.indexOf('    if (isBankAdaptiveProvider(provider)) {');
  const to=edge.indexOf('    // ── field extraction',from);
  assert.ok(from>0 && to>from);
  for(const [raw,expected] of [['Transfer successful\nPending','TRANSFER_PENDING'],['Sent!\nTransaction reversed','TRANSFER_STATUS_INVALID']]) {
    const context={provider:'gotyme',isBankAdaptiveProvider:()=>true,ocrOriginalText:raw,readReceiptTransferStatus:status,flags:[]};
    vm.runInNewContext(edge.slice(from,to),context);
    assert.deepEqual(Array.from(context.flags),[expected]);
  }
  const context={provider:'gotyme',isBankAdaptiveProvider:()=>true,ocrOriginalText:'Transfer successful\nProcessing time: Instant',readReceiptTransferStatus:status,flags:[]};
  vm.runInNewContext(edge.slice(from,to),context);
  assert.equal(context.flags.length,0);
});

test('native field recovery updates readable evidence but retains global review flags and original account confidence', async()=>{
  const from=edge.indexOf('    // Recover a missing principal from actual whole-image reads');
  const to=edge.indexOf('    // A failed optional panel read',from);
  assert.ok(from>0 && to>from);
  const original={read:{text:'original'},parsed:{provider:'gotyme',receipt:{}}};
  const improved={provider:'gotyme',receipt:{amount:{amount:4240},recipient:{accountSuffix:'9W07'}}};
  const context={providerParse:original.parsed,originalBankReading:original,
    bankReadingRecovery:{accepted:false,observations:[{read:{text:'observed'}}]},
    gotymeFieldRecovery:null,recipientRefinement:null,gotymeNativeFusion:null,
    providerContext:{},flags:['DUPLICATE_REF'],ocrFallbackReason:'google_missing_amount',
    recoverGotymeNativeFields:input=>{
      assert.equal(input.original,original);
      return {safeToUse:true,applied:true,parsed:improved,recoveredFields:['amount'],conservationFlags:[],approval:{confidence:.5,source:'bank_payment_fields'}};
    }};
  vm.runInNewContext(edge.slice(from,to),context);
  assert.equal(context.providerParse,improved);
  assert.deepEqual(context.flags,['DUPLICATE_REF']);
  assert.equal(context.ocrFallbackReason,null);
  const approvalFrom=edge.indexOf('    const approval = provider === "gcash"');
  const approvalTo=edge.indexOf('    const minimumOcrConfidence',approvalFrom);
  context.provider='gotyme';
  vm.runInNewContext(edge.slice(approvalFrom,approvalTo)+'\nthis.observedConfidence=approvalConfidence;',context);
  assert.equal(context.observedConfidence,.5,'recovered amount cannot raise account confidence');
  context.recipientRefinement={accepted:true};
  context.providerParse=original.parsed;
  vm.runInNewContext(edge.slice(from,to),context);
  assert.equal(context.providerParse,original.parsed,'successful dedicated recipient refinement keeps priority');
});

test('owner selected GoTyme name policy ignores the account only for GoTyme and still requires a matching name',()=>{
  const from=edge.indexOf('    const recipientMatch = providerVerification?.provider === "gcash"');
  const to=edge.indexOf('    const cleanEvidence',from);
  for (const [provider,policy,name,expected] of [
    ['gotyme','masked_name_only','masked_compatible',true],
    ['gotyme','masked_name_only','mismatch',false],
    ['gotyme','masked_name_only','missing',false],
    ['gotyme','name_and_account','masked_compatible',false],
    ['maribank','masked_name_only','masked_compatible',false],
  ]) {
    const context={providerVerification:{provider,recipientComparison:{name,phone:'missing',account:'mismatch'}},providerContext:{gotymeRecipientPolicy:policy}};
    vm.runInNewContext(edge.slice(from,to)+'\nthis.match=recipientMatch;',context);
    assert.equal(context.match,expected,`${provider}/${policy}/${name}`);
  }
  assert.match(edge,/gotymeRecipientPolicy: settings\.gotyme_receipt_recipient_policy === "masked_name_only"/,'policy comes from server settings');
});

test('name-only GoTyme skips recipient crops when the original name already has strong native evidence',async()=>{
  let recipientCalls=0;
  const {calls}=await runRecovery({provider:'gotyme',context:{
    providerContext:{gotymeRecipientPolicy:'masked_name_only'},
    bankApprovalConfidence:()=>({confidence:.5,fields:{recipientName:{confidence:.94}}}),
    recoverGotymeFields:async()=>{recipientCalls++;throw Error('unnecessary recipient reread');},
  }});
  assert.equal(recipientCalls,0);
  assert.equal(calls.filter(call=>call.type==='recovery').length,1,'amount can use bounded full-image recovery');
});
