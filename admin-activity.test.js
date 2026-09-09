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
