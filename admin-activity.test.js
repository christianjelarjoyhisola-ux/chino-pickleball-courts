const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Activity = require('./admin-activity.js');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const item = (id, extra = {}) => ({ id, occurredAt: '2026-09-09T16:05:00Z', actorName: 'Court operator', actorRole: 'court_owner', source: 'database_change', action: 'update', targetType: 'courts', targetId: 'court_1', summary: 'Court availability changed', ...extra });
function harness(db = {}) {
  let session = { id: 'owner-1', role: 'owner' };
  const states = [];
  const store = Activity.createStore({ db, getSession: () => session, canOwner: current => current.role === 'owner', onChange: value => states.push(value) });
  return { store, states, setSession(value) { session = value; } };
}

test('activity reads and details are refused for every non-owner role and missing session', async () => {
  let calls = 0;
  const h = harness({ getAdminActivity: async () => { calls++; return { items: [] }; }, getAdminActivityDetail: async () => { calls++; } });
  for (const role of ['court_owner', 'staff', 'host', '', 'system']) {
    h.setSession({ id: 'other', role });
    assert.equal(await h.store.load(), false);
    assert.equal(await h.store.detail('1'), false);
  }
  h.setSession(null);
  await h.store.load();
  assert.equal(calls, 0);
  assert.equal(h.store.getState().items.length, 0);
});

test('owner list applies filters and opaque cursor, deduplicating overlapping pages', async () => {
  const calls = [];
  const h = harness({ getAdminActivity: async filters => {
    calls.push(filters);
    return { items: filters.cursor ? [item('2'), item('1')] : [item('3'), item('2')], actors: [{ id: 'a', name: 'Operator', role: 'court_owner' }], nextCursor: filters.cursor ? null : 'opaque-cursor', startedAt: '2026-09-09T01:00:00Z', capabilities: { authAuditCaptured: true } };
  } });
  const filters = { fromDate: '2026-09-08', toDate: '2026-09-09', actorId: 'a', category: 'courts' };
  await h.store.load(filters);
  await h.store.load(filters, true);
  assert.deepEqual(calls[0], { ...filters, cursor: undefined, limit: 30 });
  assert.deepEqual(calls[1], { ...filters, cursor: 'opaque-cursor', limit: 30 });
  assert.deepEqual(h.store.getState().items.map(row => row.id), ['3', '2', '1']);
  assert.equal(h.store.getState().nextCursor, null);
  assert.equal(h.store.getState().capabilities.authAuditCaptured, true);
});

test('operators remain selectable with no recorded activity or matching events', async () => {
  const actors = [{ id: 'new-court-owner', name: 'CHINO Court Owner', role: 'court_owner' }];
  const calls = [];
  const h = harness({ getAdminActivity: async filters => {
    calls.push(filters);
    return { items: [], actors, nextCursor: null };
  } });
  await h.store.load();
  assert.deepEqual(h.store.getState().actors, actors);
  assert.deepEqual(h.store.getState().items, []);
  await h.store.load({ actorId: actors[0].id, category: 'courts' });
  assert.equal(calls[1].actorId, 'new-court-owner');
  assert.deepEqual(h.store.getState().actors, actors);
  assert.deepEqual(h.store.getState().items, []);
});

test('late history response is erased when owner changes to court owner', async () => {
  const pending = deferred();
  const h = harness({ getAdminActivity: () => pending.promise });
  const loading = h.store.load();
  h.setSession({ id: 'court-owner', role: 'court_owner' });
  pending.resolve({ items: [item('sensitive')], actors: [{ id: 'a', name: 'Private owner' }], startedAt: '2026-09-09' });
  assert.equal(await loading, false);
  assert.deepEqual(h.store.getState().items, []);
  assert.deepEqual(h.store.getState().actors, []);
  assert.equal(h.store.getState().startedAt, null);
  assert.ok(h.states.every(state => !state.items.some(row => row.id === 'sensitive')));
});

test('late details and old-owner data do not survive a logout or a different owner session', async () => {
  const pending = deferred();
  const h = harness({ getAdminActivity: async () => ({ items: [item('1')] }), getAdminActivityDetail: () => pending.promise });
  await h.store.load();
  const loading = h.store.detail('1');
  h.setSession({ id: 'owner-2', role: 'owner' });
  pending.resolve(item('1', { before: { private: 'old owner data' } }));
  await loading;
  assert.deepEqual(h.store.getState().items, []);
  assert.equal(h.store.getState().detail, null);
  h.setSession(null);
  h.store.authorized();
  assert.equal(h.store.getState().detail, null);
});

test('newer filters win against an older in-flight page and failed refresh clears old rows', async () => {
  const pending = deferred(); let calls = 0;
  const h = harness({ getAdminActivity: async () => {
    if (++calls === 1) return pending.promise;
    if (calls === 3) throw new Error('secret database error');
    return { items: [item('new')] };
  } });
  const first = h.store.load({ category: 'courts' });
  await h.store.load({ category: 'payments' });
  pending.resolve({ items: [item('old')] });
  await first;
  assert.deepEqual(h.store.getState().items.map(row => row.id), ['new']);
  await h.store.load();
  assert.deepEqual(h.store.getState().items, []);
  assert.match(h.store.getState().error, /could not be loaded/);
  assert.doesNotMatch(h.store.getState().error, /secret/);
});

test('closing detail before response prevents it reopening and arbitrary IDs are not fetched', async () => {
  const pending = deferred(); let calls = 0;
  const h = harness({ getAdminActivity: async () => ({ items: [item('1')] }), getAdminActivityDetail: () => { calls++; return pending.promise; } });
  await h.store.load();
  assert.equal(await h.store.detail('not-visible'), false);
  assert.equal(calls, 0);
  const opening = h.store.detail('1');
  h.store.closeDetail(); pending.resolve(item('1'));
  await opening;
  assert.equal(h.store.getState().detail, null);
  assert.equal(h.store.getState().detailLoading, false);
});

test('saved changes, reported outcomes and observed views retain distinct meanings', () => {
  assert.equal(Activity.sourceLabel({ source: 'database_change', outcome: 'success' }).label, 'Saved change');
  assert.equal(Activity.sourceLabel({ source: 'client_reported', outcome: 'attempt' }).label, 'Attempt');
  assert.equal(Activity.sourceLabel({ source: 'client_reported', outcome: 'view' }).label, 'Viewed');
  assert.equal(Activity.sourceLabel({ source: 'client_reported', outcome: 'success' }).label, 'Reported success');
  assert.equal(Activity.sourceLabel({ source: 'client_reported', outcome: 'failed' }).label, 'Reported failure');
  assert.equal(Activity.sourceLabel({ source: 'server_reported' }).label, 'Server event');
  assert.equal(Activity.sourceLabel({ source: 'auth_event' }).label, 'Account event');
});

test('all untrusted row, detail and field values are escaped, and identical fields are omitted', () => {
  const evil = '<img src=x onerror="steal()">';
  const record = item('" onclick="steal()', { actorName: evil, actorRole: evil, summary: evil, targetType: evil, targetId: evil, before: { [evil]: evil, unchanged: 'same' }, after: { [evil]: '<script>bad()</script>', unchanged: 'same' }, details: { event: evil } });
  for (const html of [Activity.itemMarkup(record, 0), Activity.detailMarkup(record)]) {
    assert.doesNotMatch(html, /<img|<script|onclick="steal/);
    assert.match(html, /&lt;img/);
  }
  assert.doesNotMatch(Activity.detailMarkup(record), /<h5>unchanged/);
});

test('history timestamps cross midnight in Philippine time, independent of viewer timezone', () => {
  const label = Activity.dateLabel('2026-09-09T16:05:00Z');
  assert.match(label, /Sep 10, 2026/);
  assert.match(label, /12:05:00 AM/);
  assert.equal(Activity.dateLabel('garbage'), 'Date unavailable');
});

test('redacted fields still appear as changed when the database confirms the field changed', () => {
  const html = Activity.detailMarkup(item('1', { changedFields: ['payment_reference', 'receipt_url'], before: { payment_reference: '[REDACTED]', receipt_url: '[REDACTED]' }, after: { payment_reference: '[REDACTED]', receipt_url: '[REDACTED]' } }));
  assert.match(html, /payment reference/);
  assert.match(html, /receipt url/);
  assert.match(html, /This field changed. Sensitive values are hidden/);
  assert.doesNotMatch(html, /No before-and-after change/);
});

function fakeElement(code, extra = {}) {
  return { closest: () => null, getAttribute: name => /^on/.test(name) ? code : null, hasAttribute: () => false, value: 'secret input', textContent: 'Private customer name', ...extra };
}
test('semantic observation excludes arguments, customer text and entered values', () => {
  const event = Activity.observationFor(fakeElement("confirmPayment('private-ref', 'customer@example.test')"));
  assert.equal(event.action, 'confirmPayment');
  assert.equal(event.outcome, 'attempt');
  assert.doesNotMatch(JSON.stringify(event), /private-ref|customer@|secret input|Private customer/);
  assert.equal(Activity.observationFor(fakeElement('exportCSV()')).category, 'export');
  assert.equal(Activity.observationFor(fakeElement('window.PlayManager.saveSession()')).action, 'PlayManager.saveSession');
  assert.equal(Activity.observationFor(fakeElement('toggleBlock(this.value)'), 'change').action, 'toggleBlock');
  assert.equal(Activity.observationFor(fakeElement('logout()')), null);
  assert.equal(Activity.observationFor(fakeElement("goto('bookings')")), null);
  assert.equal(Activity.observationFor(fakeElement('save()', { closest: () => ({}) })), null);
});

test('observations are limited to real operator sessions and never call live recording in local data mode', () => {
  const events = []; let role = 'owner', local = false;
  const observer = Activity.createObserver({ db: { recordAdminActivity: event => events.push(event) }, getSession: () => ({ id: 'user', role }), isLocalData: () => local });
  observer.observeNavigation('bookings');
  role = 'court_owner'; observer.observeNavigation('courts');
  role = 'staff'; observer.observeNavigation('payments');
  role = 'host'; observer.observeNavigation('hosts');
  role = 'owner'; local = true; observer.observeNavigation('activity');
  local = false; observer.observeNavigation('unknown-secret-section');
  assert.deepEqual(events.map(event => event.targetId), ['bookings', 'courts']);
  assert.ok(events.every(event => event.outcome === 'view'));
});

test('delegated play manager and balance buttons record semantic attempts without their arguments', () => {
  const button = fakeElement('', { getAttribute: name => name === 'data-pm-action' ? 'replace-player' : null, dataset: { playerId: 'private-player-id' } });
  assert.deepEqual(Activity.observationFor(button), { category: 'interaction', action: 'play_manager_replace_player', outcome: 'attempt' });
  const form = fakeElement('', { getAttribute: name => name === 'data-pm-form' ? 'setup' : null });
  assert.equal(Activity.observationFor(form, 'submit').action, 'play_manager_submit_setup');
  assert.equal(Activity.observationFor(fakeElement('', { id: 'hostBalanceApproveBtn' })).action, 'confirmHostBalanceReceived');
  assert.equal(Activity.observationFor(fakeElement('', { getAttribute: () => 'unrecognized-private-value' })), null);
});

test('failed observer transport never blocks the operational action', async () => {
  const observer = Activity.createObserver({ db: { recordAdminActivity: async () => { throw new Error('offline'); } }, getSession: () => ({ id: 'a', role: 'court_owner' }) });
  assert.doesNotThrow(() => observer.observeNavigation('bookings'));
  await new Promise(resolve => setImmediate(resolve));
});

test('admin owner-only navigation denies direct activity routes before loader is called', async () => {
  const admin = fs.readFileSync(`${__dirname}/admin.html`, 'utf8');
  const canAccess = admin.slice(admin.indexOf('function canAccessSection('), admin.indexOf('function firstAllowedSection('));
  const goto = admin.slice(admin.indexOf('async function goto('), admin.indexOf('async function restoreSectionFromLocation('));
  let calls = 0;
  const context = vm.createContext({ sess: { role: 'court_owner' }, SECTION_LOADERS: { activity: () => calls++ }, SECTION_PERM: { activity: 'owner_only' }, $: () => ({}), Auth: { can: (permission, role) => permission === 'owner_only' && role === 'owner' }, toast() {} });
  vm.runInContext(canAccess + goto, context);
  assert.equal(await vm.runInContext("goto('activity')", context), false);
  assert.equal(calls, 0);
  context.sess = null;
  assert.equal(await vm.runInContext("goto('activity')", context), false);
  assert.equal(calls, 0);
  assert.match(admin, /data-s="activity" data-perm="owner_only"/);
  assert.match(admin, /_adminSessionInvalidated=true;\s*_adminActivity\?\.clear\(\)/);
  assert.match(admin, /function logout\(\)\{ _adminActivity\?\.clear\(\); Auth.logout\(\); \}/);
});


test('an empty booking-change message check is clearly labelled without claiming a manual action', () => {
  const record = item('notification-empty', { source: 'client_reported', action: 'dispatchBookingRescheduleNotifications', outcome: 'skipped', summary: 'Reported result: dispatchBookingRescheduleNotifications', targetType: '', targetId: '', details: { page: 'dash', event: 'action_result' } });
  const label = Activity.sourceLabel(record);
  assert.equal(label.label, 'Nothing to send');
  assert.equal(label.kind, 'view');
  assert.match(label.explanation, /no booking-change messages were ready/);
  assert.match(label.explanation, /can run automatically/);
  const row = Activity.itemMarkup(record, 0);
  assert.match(row, /Checked for booking-change messages/);
  assert.doesNotMatch(row, /Not completed|dispatch Booking|Server reported edge request/);
  const detail = Activity.detailMarkup(record);
  assert.ok(detail.includes('<dt>Result</dt><dd>Nothing to send'));
  assert.match(detail, /Check booking-change messages/);
  assert.match(detail, /dispatchBookingRescheduleNotifications/); // Original action stays available for audit.
  assert.match(detail, /recordedOutcome/);
  assert.equal(record.outcome, 'skipped');
});

test('notification server request stages preserve outcomes and never claim message delivery', () => {
  for (const [outcome, expected] of [['attempted', 'Request started'], ['success', 'Request succeeded'], ['failed', 'Request failed'], ['denied', 'Access denied']]) {
    const record = item('server', { source: 'server_reported', action: 'dispatch', outcome, targetType: 'reschedule_request', targetId: 'booking-reschedule-notifications', details: { endpoint: 'booking-reschedule-notifications', event: 'edge_request', action: 'dispatch' } });
    assert.equal(Activity.sourceLabel(record).label, expected);
    assert.match(Activity.sourceLabel(record).explanation, /can run automatically/);
    assert.match(Activity.itemMarkup(record, 0), /booking-change message/i);
    assert.doesNotMatch(Activity.itemMarkup(record, 0), /messages sent|booking changed|Server reported edge request/i);
    assert.ok(Activity.detailMarkup(record).includes('<dt>Result</dt><dd>' + expected));
  }
  const retry = item('retry', { source: 'server_reported', action: 'retry', outcome: 'failed', details: { endpoint: 'booking-reschedule-notifications', event: 'edge_request', action: 'retry' } });
  assert.match(Activity.itemMarkup(retry, 0), /Requested another attempt to send booking-change messages/);
  assert.equal(Activity.sourceLabel(retry).label, 'Request failed');
  assert.doesNotMatch(Activity.itemMarkup(retry, 0), /Automatic/);
});

test('generic skipped actions and unrelated saved changes keep their original meanings', () => {
  assert.equal(Activity.sourceLabel({ source: 'client_reported', action: 'saveCourt', outcome: 'skipped' }).label, 'Skipped');
  const saved = item('saved', { source: 'database_change', action: 'dispatchBookingRescheduleNotifications', summary: 'Updated court settings', outcome: 'success' });
  assert.equal(Activity.sourceLabel(saved).label, 'Saved change');
  assert.match(Activity.itemMarkup(saved, 0), /Updated court settings/);
  const unrelated = item('other', { source: 'client_reported', action: 'other', summary: 'dispatchBookingRescheduleNotifications', outcome: 'skipped' });
  assert.equal(Activity.sourceLabel(unrelated).label, 'Skipped');
  const server = item('server', { source: 'server_reported', action: 'post', outcome: 'success', details: { event: 'edge_request', endpoint: 'integration-status' } });
  assert.equal(Activity.sourceLabel(server).label, 'Request succeeded');
  assert.match(Activity.itemMarkup(server, 0), /Service request/);
  assert.doesNotMatch(Activity.itemMarkup(server, 0), /booking-change/);
});

test('page and action context use the visited destination without guessing a page from a saved record', () => {
  const visit = item('visit', { source: 'client_reported', action: 'page_view', targetId: 'accounts', summary: 'Viewed payments', details: { page: 'payments' }, outcome: 'viewed' });
  assert.equal(Activity.activityPage(visit), 'Host accounts');
  const click = item('click', { source: 'client_reported', action: 'host_account_open', targetType: '', targetId: '', outcome: 'attempted', details: { page: 'accounts', event: 'action_attempt' } });
  const row = Activity.itemMarkup(click, 0);
  assert.match(row, /data-label="Page"[^>]*><span[^>]*>Host accounts/);
  assert.match(row, /Open host bookings and balance/);
  assert.match(row, /Requested/);
  assert.doesNotMatch(row, /Created|Saved change|Reported result|host_account_open/);
  const saved = item('saved', { action: 'insert', targetType: 'accounts', summary: 'Created accounts', details: {} });
  assert.equal(Activity.activityPage(saved), 'Not recorded');
  assert.match(Activity.itemMarkup(saved, 0), /Created account/);
  assert.doesNotMatch(Activity.itemMarkup(saved, 0), /Host accounts/);
  assert.equal(Activity.activityPage({ source: 'server_reported', details: { page: 'accounts' } }), 'Not recorded');
  assert.equal(Activity.activityPage({ source: 'client_reported', details: { page: '<script>' } }), 'Not recorded');
});

test('tagged host controls record only allowlisted actions, their page, and the intended event type', () => {
  const attributes = { 'data-activity-action': 'host_bookings_search', 'data-activity-page': 'accounts', 'data-activity-event': 'change' };
  const control = fakeElement('saveAccount(secret)', { getAttribute: name => attributes[name] || null });
  assert.equal(Activity.observationFor(control, 'click'), null);
  assert.deepEqual(Activity.observationFor(control, 'change'), { category: 'interaction', action: 'host_bookings_search', page: 'accounts', outcome: 'attempt' });
  attributes['data-activity-action'] = 'private@example.test';
  assert.equal(Activity.observationFor(control, 'change'), null);
});

test('observer keeps current page for modal controls and explicitly records the new navigation page', () => {
  const events = [], listeners = {};
  const observer = Activity.createObserver({ db: { recordAdminActivity: event => events.push(event) }, getSession: () => ({ id: 'court-owner', role: 'court_owner' }) });
  observer.install({ addEventListener: (name, listener) => { listeners[name] = listener; }, defaultView: { addEventListener() {} } });
  observer.observeNavigation('accounts');
  const control = fakeElement('openHostAccountDetails()');
  listeners.click({ isTrusted: true, target: { closest: () => control } });
  observer.observeNavigation('bookings');
  assert.deepEqual(events.map(event => event.page), ['accounts', 'accounts', 'bookings']);
  assert.equal(events[1].action, 'openHostAccountDetails');
  listeners.click({ isTrusted: false, target: { closest: () => control } });
  assert.equal(events.length, 3);
});
