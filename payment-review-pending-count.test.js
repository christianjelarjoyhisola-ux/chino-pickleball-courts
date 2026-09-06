const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const admin = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const helpersStart = admin.indexOf('let _paymentReviewRenderSeq =');
const helpersEnd = admin.indexOf('let calYear=', helpersStart);
const statusesStart = admin.indexOf('function bookingReviewStatus(');
const statusesEnd = admin.indexOf('function statusPill(', statusesStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'payment-review implementation must exist');
assert.ok(statusesStart >= 0 && statusesEnd > statusesStart, 'real receipt status classifiers must exist');
const implementation = admin.slice(statusesStart, statusesEnd) + admin.slice(helpersStart, helpersEnd);

function element() {
  let text = '';
  return {
    get textContent() { return text; },
    set textContent(value) { text = String(value); },
    hidden: true,
    value: '',
    innerHTML: '',
    attributes: {},
    actions: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    focus(options) { this.actions.push({ type: 'focus', options }); },
    scrollIntoView(options) { this.actions.push({ type: 'scroll', options }); },
  };
}

function harness({ bookings = [], regs = [], hostRegs = [], hostSessions = [], owner = true,
  summary = { status: 'ready', count: 0 }, db = {} } = {}) {
  const nodes = Object.fromEntries([
    'prPending', 'prPendingMeta', 'prPendingHostLink', 'prNeedsReview', 'prAuto',
    'prRejected', 'prSearch', 'prType', 'prStatus', 'prQueueMeta', 'prQueueBody',
    'prLogBody', 'hostBalanceAdminPanel',
  ].map(id => [id, element()]));
  nodes.prStatus.value = 'attention';
  let currentSummary = summary;
  let summaryReads = 0;
  const sandbox = {
    $: id => nodes[id],
    canViewHostPaymentHistory: () => owner,
    HostBalanceAdmin: {
      pendingSummary: () => { summaryReads += 1; return currentSummary; },
      invalidate: () => {},
    },
    DB: {
      getBookings: async () => bookings,
      getOpenPlayRegistrations: async () => regs,
      getOpenPlayHostSessionRegistrations: async () => hostRegs,
      getOpenPlayHostSessions: async () => hostSessions,
      ...db,
    },
    groupBookings: rows => rows,
    isDigitalPayment: method => ['gcash', 'maya', 'bpi'].includes(method),
    fmtD: value => value || '--',
    hostFmtTime: value => String(value),
    paymentReviewRow: row => `${row.type}:${row.id}:${row.status}`,
    paymentReviewWhenText: value => value || '--',
    paymentMethodLabel: value => value || '--',
    statusPill: value => value,
    esc: value => String(value),
    fmt: value => String(value),
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(implementation, context, { filename: 'admin-payment-review.js' });
  return {
    context,
    nodes,
    setSummary(value) { currentSummary = value; },
    get summaryReads() { return summaryReads; },
  };
}

function pendingBooking(ref = 'BOOKING-1', extra = {}) {
  return {
    ref, fullName: ref, paymentMethod: 'gcash', receiptImageUrl: 'receipt.png',
    status: 'pending', paymentStatus: 'for_verification', ...extra,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Pending combines initial payments and the distinct host-balance summary without double counting updates', async () => {
  const h = harness({
    bookings: [pendingBooking(), pendingBooking('MANUAL', { receiptStatus: 'manual_review' })],
    regs: [{ id: 2, payment_method: 'gcash', payment_status: 'pending' }],
    hostRegs: [{ id: 3, paymentMethod: 'gcash', paymentStatus: 'for_verification' }],
    summary: { status: 'ready', count: 2 },
  });
  await h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '5');
  assert.equal(h.nodes.prNeedsReview.textContent, '1');
  assert.equal(h.nodes.prPendingMeta.textContent, 'Includes 2 host balance payments');
  assert.equal(h.nodes.prPendingHostLink.hidden, false);

  h.context.syncPaymentReviewPendingCount();
  h.context.syncPaymentReviewPendingCount();
  await h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '5', 'repeated notifications and rendering must replace the total');
});

test('approved and rejected host balances leave Pending as the summary changes', async () => {
  const h = harness({ bookings: [pendingBooking()], summary: { status: 'ready', count: 2 } });
  await h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '3');

  h.setSummary({ status: 'ready', count: 1 });
  h.context.syncPaymentReviewPendingCount();
  assert.equal(h.nodes.prPending.textContent, '2');
  assert.equal(h.nodes.prPendingMeta.textContent, 'Includes 1 host balance payment');

  h.setSummary({ status: 'ready', count: 0 });
  h.context.syncPaymentReviewPendingCount();
  assert.equal(h.nodes.prPending.textContent, '1');
  assert.equal(h.nodes.prPendingMeta.hidden, true);
  assert.equal(h.nodes.prPendingHostLink.hidden, true);
});

test('a confirmed host deposit remains resolved while its separate balance awaits review', async () => {
  const booking = pendingBooking('HOST-CONFIRMED', {
    hostBooking: true, status: 'confirmed', paymentStatus: 'downpayment_paid', receiptStatus: 'manual_review',
  });
  const h = harness({ bookings: [booking], summary: { status: 'ready', count: 1 } });
  await h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '1', 'only the submitted balance needs review');
  assert.equal(h.nodes.prAuto.textContent, '1', 'accepted deposit stays in the resolved payment total');
  assert.equal(h.nodes.prNeedsReview.textContent, '0');
  assert.equal(h.nodes.prQueueMeta.textContent, 'Showing 0 payments');
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.paymentStatus, 'downpayment_paid');
});

test('unknown and failed host-balance summaries show explicit unavailable counts with no review link', async () => {
  const h = harness({ bookings: [pendingBooking()], summary: { status: 'loading', count: null } });
  await h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '\u2026');
  assert.equal(h.nodes.prPendingMeta.textContent, 'Loading host balances\u2026');
  assert.equal(h.nodes.prPendingHostLink.hidden, true);

  h.setSummary({ status: 'error', count: null });
  h.context.syncPaymentReviewPendingCount();
  assert.equal(h.nodes.prPending.textContent, '\u2014');
  assert.match(h.nodes.prPendingMeta.textContent, /unavailable.*Refresh/);
  assert.equal(h.nodes.prPendingHostLink.hidden, true);

  h.setSummary({ status: 'ready', count: 0 });
  h.context.syncPaymentReviewPendingCount();
  assert.equal(h.nodes.prPending.textContent, '1', 'a verified empty summary restores the initial-payment count');
});

test('base payment loading hides stale totals and the host link until its query finishes', async () => {
  const waiting = deferred();
  let reads = 0;
  const h = harness({
    summary: { status: 'ready', count: 1 },
    db: { getBookings: () => ++reads === 1 ? [pendingBooking()] : waiting.promise },
  });
  await h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '2');
  assert.equal(h.nodes.prPendingHostLink.hidden, false);

  const render = h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '\u2026');
  assert.equal(h.nodes.prPendingMeta.textContent, 'Loading pending payments\u2026');
  assert.equal(h.nodes.prPendingHostLink.hidden, true);
  waiting.resolve([]);
  await render;
  assert.equal(h.nodes.prPending.textContent, '1');
});

test('staff sees its initial-payment count without reading the owner-only balance summary', async () => {
  const h = harness({ owner: false, bookings: [pendingBooking()], summary: { status: 'ready', count: 99 } });
  await h.context.renderPaymentReview();
  h.context.syncPaymentReviewPendingCount();
  assert.equal(h.summaryReads, 0);
  assert.equal(h.nodes.prPending.textContent, '1');
  assert.equal(h.nodes.prPendingMeta.hidden, true);
  assert.equal(h.nodes.prPendingHostLink.hidden, true);
});

test('Refresh invalidates the host-balance cache before calling the current wrapped renderer', async () => {
  const h = harness();
  const events = [];
  h.context.HostBalanceAdmin.invalidate = () => events.push('invalidate');
  const originalRender = h.context.renderPaymentReview;
  h.context.renderPaymentReview = async () => {
    events.push('wrapped-render');
    await originalRender();
    return 'refreshed';
  };
  assert.equal(await h.context.refreshPaymentReview(), 'refreshed');
  assert.deepEqual(events, ['invalidate', 'wrapped-render']);
});

test('Review host balances moves keyboard focus and scrolls to the balance review panel', () => {
  const h = harness();
  h.context.reviewPendingHostBalances();
  const panel = h.nodes.hostBalanceAdminPanel;
  assert.equal(panel.attributes.tabindex, '-1');
  assert.deepEqual(panel.actions.map(action => action.type), ['focus', 'scroll']);
  assert.equal(panel.actions[0].options.preventScroll, true);
  assert.equal(panel.actions[1].options.block, 'start');
  assert.equal(panel.actions[1].options.behavior, 'smooth');
  delete h.nodes.hostBalanceAdminPanel;
  assert.doesNotThrow(() => h.context.reviewPendingHostBalances());
});

test('a slower prior payment query cannot overwrite a newer pending count or queue', async () => {
  const oldBookings = deferred();
  let reads = 0;
  const h = harness({
    summary: { status: 'ready', count: 1 },
    db: { getBookings: () => ++reads === 1 ? oldBookings.promise : [pendingBooking('NEW')] },
  });
  const oldRender = h.context.renderPaymentReview();
  await h.context.renderPaymentReview();
  assert.equal(h.nodes.prPending.textContent, '2');
  assert.match(h.nodes.prQueueBody.innerHTML, /NEW/);

  oldBookings.resolve([pendingBooking('OLD-1'), pendingBooking('OLD-2')]);
  await oldRender;
  assert.equal(h.nodes.prPending.textContent, '2');
  assert.match(h.nodes.prQueueBody.innerHTML, /NEW/);
  assert.doesNotMatch(h.nodes.prQueueBody.innerHTML, /OLD/);
});
