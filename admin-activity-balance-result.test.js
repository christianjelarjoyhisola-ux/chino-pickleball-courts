const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const HostBalancePayment = require('./host-balance-payment.js');

const source = fs.readFileSync('host-balance-admin.js', 'utf8');
const start = source.indexOf('  function supabaseClient()');
const end = source.indexOf('  function addStyles()', start);
assert.ok(start >= 0 && end > start, 'The tested transport is the actual host balance admin transport');

function setup(options = {}) {
  let session = options.session === undefined
    ? { id: 'operator-one', role: 'court_owner', status: 'active' }
    : options.session;
  const records = [], requests = [];
  const global = {
    location: { hash: options.hash || '#payreview' },
    Auth: { getSession: () => session },
    PB_USE_LOCAL_DATA: !!options.local,
    HostBalancePayment,
    _supabase: { functions: { invoke: async (name, request) => {
      requests.push({ name, request });
      return options.response ? options.response(name, request) : { data: { ok: true }, error: null };
    } } },
    DB: { recordAdminActivity: async event => {
      records.push(JSON.parse(JSON.stringify(event)));
      if (options.telemetryError) throw options.telemetryError;
    } },
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobal.request = apiCall;', { global });
  return { global, records, requests, setSession: next => { session = next; }, request: global.request };
}

test('records the actual successful approve and reject responses without payment contents', async () => {
  for (const [decision, action] of [['approve', 'approveHostBalancePayment'], ['reject', 'rejectHostBalancePayment']]) {
    const data = { ok: true, payment: { receiptUrl: 'https://private.example/receipt', amount: 1234 } };
    const harness = setup({ response: async () => ({ data, error: null }) });
    const result = await harness.request('review', {
      paymentId: 'payment-123', decision, reason: 'PRIVATE REVIEW NOTE',
      receipt: 'PRIVATE RECEIPT', email: 'private@example.test',
    });
    assert.equal(result, data, 'The original business response is returned unchanged');
    assert.equal(harness.requests.length, 1);
    assert.deepEqual(harness.records, [{
      category: 'result', action, outcome: 'success', page: 'payreview',
      targetType: 'host_booking_balance_payments', targetId: 'payment-123',
    }]);
    assert.doesNotMatch(JSON.stringify(harness.records), /PRIVATE|receipt|1234|private@example/);
  }
});

test('records network, rejected-payload, and invalid-response failures without changing their errors', async () => {
  const cases = [
    { response: async () => { throw new Error('Private network error'); }, message: /Private network error/ },
    { response: async () => ({ error: new Error('Private transport failure'), data: null }), message: /Private transport failure/ },
    { response: async () => ({ error: null, data: { ok: false, error: 'Private rejected decision' } }), message: /Private rejected decision/ },
    { response: async () => ({ error: null, data: null }), message: /not accepted/ },
  ];
  for (const scenario of cases) {
    const harness = setup(scenario);
    await assert.rejects(harness.request('review', { paymentId: 'payment-123', decision: 'reject', reason: 'Private reason' }), scenario.message);
    assert.equal(harness.records.length, 1);
    assert.equal(harness.records[0].outcome, 'failed');
    assert.equal(harness.records[0].action, 'rejectHostBalancePayment');
    assert.doesNotMatch(JSON.stringify(harness.records), /Private/);
  }
});

test('does not turn a skipped or unconfirmed response into a successful payment decision', async () => {
  for (const [data, outcome] of [[{ ok: true, skipped: true }, 'skipped'], [{ requestId: 'pending' }, 'attempt']]) {
    const harness = setup({ response: async () => ({ data, error: null }) });
    assert.equal(await harness.request('review', { decision: 'unknown' }), data);
    assert.equal(harness.records[0].action, 'reviewHostBalancePayment');
    assert.equal(harness.records[0].outcome, outcome);
  }
});

test('keeps the originating page after navigation and records only after the response arrives', async () => {
  let finish;
  const harness = setup({ hash: '#accounts', response: () => new Promise(resolve => { finish = resolve; }) });
  const pending = harness.request('review', { paymentId: 'payment-123', decision: 'approve' });
  assert.equal(harness.records.length, 0);
  harness.global.location.hash = '#dash';
  finish({ data: { ok: true }, error: null });
  await pending;
  assert.equal(harness.records[0].page, 'accounts');
});

test('does not attribute a late response to a different account, role, or inactive session', async () => {
  for (const session of [
    { id: 'operator-two', role: 'court_owner', status: 'active' },
    { id: 'operator-one', role: 'owner', status: 'active' },
    { id: 'operator-one', role: 'court_owner', status: 'suspended' },
    null,
  ]) {
    let finish;
    const harness = setup({ response: () => new Promise(resolve => { finish = resolve; }) });
    const pending = harness.request('review', { paymentId: 'payment-123', decision: 'approve' });
    harness.setSession(session);
    finish({ data: { ok: true }, error: null });
    await pending;
    assert.equal(harness.records.length, 0);
  }
});

test('records permitted staff results but excludes local data, host accounts, and read requests', async () => {
  const staff = setup({ session: { id: 'staff-one', role: 'staff', status: 'active' } });
  await staff.request('review', { decision: 'reject' });
  assert.equal(staff.records.length, 1);

  for (const options of [
    { local: true }, { session: null }, { session: { id: 'host-one', role: 'host' } },
    { session: { id: 'operator-one', role: 'court_owner', status: 'suspended' } },
  ]) {
    const harness = setup(options);
    await harness.request('review', { decision: 'approve' });
    assert.equal(harness.records.length, 0);
  }
  for (const action of ['list_pending', 'receipt_url', 'history_for_booking']) {
    const harness = setup();
    await harness.request(action, { paymentId: 'payment-123' });
    assert.equal(harness.records.length, 0);
  }
});

test('audit failures never turn successful reviews into failures or replace the original failure', async () => {
  const successful = setup({ telemetryError: new Error('Audit unavailable') });
  assert.equal((await successful.request('review', { decision: 'approve' })).ok, true);
  assert.equal(successful.records.length, 1);

  const original = new Error('Original business error');
  const failed = setup({ telemetryError: new Error('Audit unavailable'), response: async () => { throw original; } });
  await assert.rejects(failed.request('review', { decision: 'reject' }), error => error === original);
  assert.equal(failed.records.length, 1);
  assert.equal(failed.records[0].outcome, 'failed');
});

test('unknown locations and unsafe payment identifiers are not copied to activity history', async () => {
  const harness = setup({ hash: '#private@example.test/secret' });
  await harness.request('review', { paymentId: 'private@example.test/secret', decision: 'approve' });
  assert.equal(harness.records[0].page, 'admin');
  assert.equal(harness.records[0].targetId, '');
  assert.doesNotMatch(JSON.stringify(harness.records), /private|secret/);
});
