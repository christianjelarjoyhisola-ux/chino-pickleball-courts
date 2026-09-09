const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./admin-activity-operations.js');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const admin = read('admin.html');
const uiSource = [admin, read('availability-graphic.js'), read('host-balance-admin.js')].join('\n');

test('operations catalog references existing application handlers and database methods', () => {
  for (const [name, label] of Object.entries(catalog.handlers)) {
    assert.match(admin, new RegExp('\\bfunction\\s+' + name + '\\s*\\('), name);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 5 && label.length < 90, name);
  }
  const db = read('supabase-config.js');
  for (const name of Object.keys(catalog.operations)) {
    assert.match(db, new RegExp('\\b' + name + '\\s*\\('), name);
  }
});

test('explicit controls use existing stable IDs and unique safe action identifiers', () => {
  const seen = new Set();
  const selectorEvents = new Set();
  for (const control of catalog.controls) {
    assert.match(control.action, /^[a-z][a-z0-9_]+$/);
    assert.equal(seen.has(control.action), false, control.action);
    seen.add(control.action);
    const key = control.event + ':' + control.selector;
    assert.equal(selectorEvents.has(key), false, key);
    selectorEvents.add(key);
    assert.ok(['click', 'change', 'submit'].includes(control.event));
    assert.ok(control.label.length > 5);
    for (const match of control.selector.matchAll(/#([a-zA-Z][\w-]*)/g)) {
      assert.ok(uiSource.includes(match[1]), 'Missing control ID: ' + match[1]);
    }
  }
});

test('important delegated operations remain tracked when controls have no inline handlers', () => {
  const has = selector => catalog.controls.some(control => control.selector === selector);
  for (const selector of [
    '#courtActivityBody button[data-activity-ref]',
    '[data-prag-action="download"]', '[data-prag-action="share"]', '[data-prag-court]',
    '#hostBalanceApproveBtn', '#hostBalanceRejectBtn', '#hostDepositTab', '#hostBalanceTab',
    '#hostBalanceAdminList .hba-bottom button', '#hostDepositProofLink', '#hostBalanceProofLink',
    '#sec-insights .pr-insights-method > summary', '#sec-payreview .pr-log-panel > summary',
    '#sec-reports details > summary', '.mb-book-pay > summary',
  ]) assert.ok(has(selector), selector);
});

test('draft changes and searches are recorded on change without capturing entered values', () => {
  for (const selector of ['#srch', '#prSearch', '#deletedSrch', '#nbName', '#nbPhone', '#nbEmail', '#nbGcashRef', '#bookingPaymentRejectReason', '#grsNote']) {
    const control = catalog.controls.find(item => item.selector === selector);
    assert.equal(control?.event, 'change', selector);
    assert.deepEqual(Object.keys(control).sort(), ['action', 'event', 'label', ...(control.page ? ['page'] : []), 'selector'].sort());
  }
  for (const control of catalog.controls) {
    assert.equal(/\b(?:successfully|sent successfully|email delivered|saved successfully)\b/i.test(control.label), false);
  }
});

test('request decisions, payment decisions, and booking filters have distinct plain labels', () => {
  const byAction = Object.fromEntries(catalog.controls.map(control => [control.action, control]));
  assert.equal(byAction.reschedule_request_approve.label, 'Approve the player’s requested schedule');
  assert.equal(byAction.reschedule_request_decline.label, 'Decline the player’s reschedule request');
  assert.notEqual(byAction.host_balance_approve.label, byAction.host_balance_reject.label);
  assert.notEqual(byAction.booking_status_pending.label, byAction.booking_status_confirmed.label);
  assert.notEqual(byAction.report_period_week.label, byAction.report_period_month.label);
  assert.equal(byAction.payment_move_check.event, 'change');
});

test('known panel destinations reference real modal IDs and opener functions', () => {
  for (const [handler, selector] of Object.entries(catalog.panels)) {
    assert.match(admin, new RegExp('\\bfunction\\s+' + handler + '\\s*\\('), handler);
    assert.match(selector, /^#[A-Za-z][\w-]*$/);
    assert.ok(uiSource.includes(selector.slice(1)), selector);
  }
  assert.equal(catalog.panels.openVerifyModal, '#verifyModal');
  assert.equal(catalog.panels.openHostPaymentHistory, '#hostBalanceReviewModal');
  assert.equal(catalog.panels.openGroupRescheduleModal, '#groupRescheduleModal');
});
