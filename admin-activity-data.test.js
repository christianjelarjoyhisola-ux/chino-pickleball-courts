const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('supabase-config.js', 'utf8');
const activity = source.slice(source.indexOf('// Activity reads always'), source.indexOf('window.Auth = {'));
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ role = 'owner', local = false, privateSurface = true, rpc, methods = {}, authMethods = {} } = {}) {
  let session = { id: 'actor-1', role, status: 'active' };
  const requests = [];
  const context = vm.createContext({
    window: { DB: methods, PB_USE_LOCAL_DATA: local, Auth: { ...authMethods, getSession: () => session } },
    PB_PRIVATE_DATA_SURFACE: privateSurface,
    location: { hash: '#courts' },
    _extractFnError: error => error.message,
    _sb: { rpc: async (name, args) => {
      requests.push({ name, args: plain(args) });
      return rpc ? rpc(name, args) : { data: { items: [], nextCursor: null }, error: null };
    } },
    setTimeout, clearTimeout, console: { warn() {} },
  });
  vm.runInContext(activity, context);
  context._pbInstallAccountActivityObservers(context.window.Auth, context.window.DB);
  return { db: context.window.DB, auth: context.window.Auth, context, requests, setSession: value => { session = value; } };
}

test('activity history blocks non-owners and public pages before any request', async () => {
  for (const role of ['court_owner', 'staff', 'host', null]) {
    const h = harness({ role });
    await assert.rejects(h.db.getAdminActivity(), /Only the system owner/);
    await assert.rejects(h.db.getAdminActivityDetail('1'), /Only the system owner/);
    assert.equal(h.requests.length, 0);
  }
  const h = harness({ privateSurface: false });
  await assert.rejects(h.db.getAdminActivity(), /Only the system owner/);
});

test('owner activity filters use inclusive Philippine dates and bounded cursor pages', async () => {
  const h = harness();
  await h.db.getAdminActivity({ fromDate: '2026-09-09', toDate: '2026-09-09', cursor: '9223372036854775000', actorId: 'court-owner', category: 'courts', limit: 999 });
  assert.deepEqual(h.requests[0], { name: 'owner_activity_log_list', args: {
    p_from: '2026-09-08T16:00:00.000Z', p_to: '2026-09-09T16:00:00.000Z',
    p_category: 'courts', p_actor_id: 'court-owner', p_before_id: '9223372036854775000', p_limit: 100,
    p_page: null, p_view: 'people',
  } });
  for (const date of ['2026-02-30', 'garbage', '2026-13-01']) {
    await assert.rejects(h.db.getAdminActivity({ fromDate: date }), /valid activity date/);
  }
  await assert.rejects(h.db.getAdminActivity({ fromDate: '2026-09-10', toDate: '2026-09-09' }), /end date/);
});

test('activity history requests the selected page and separates service checks', async () => {
  const h = harness();
  await h.db.getAdminActivity({ page: 'accounts', view: 'people' });
  assert.equal(h.requests[0].args.p_page, 'accounts');
  assert.equal(h.requests[0].args.p_view, 'people');
  await h.db.getAdminActivity({ page: 'dash', view: 'services' });
  assert.equal(h.requests[1].args.p_page, 'dash');
  assert.equal(h.requests[1].args.p_view, 'services');
  await h.db.getAdminActivity({ view: 'all' });
  assert.equal(h.requests[2].args.p_page, null);
  assert.equal(h.requests[2].args.p_view, 'all');
});

test('history results are rejected if owner session changes during a request', async () => {
  const h = harness({ rpc: async () => {
    h.setSession({ id: 'actor-2', role: 'court_owner', status: 'active' });
    return { data: { items: [{ id: '1', summary: 'Private history' }] } };
  } });
  await assert.rejects(h.db.getAdminActivity(), /Only the system owner/);
});

test('local demo never reads or records production activity', async () => {
  const h = harness({ local: true });
  assert.equal((await h.db.getAdminActivity()).localOnly, true);
  await h.db.getAdminActivityDetail('1');
  await h.db.recordAdminActivity({ category: 'interaction', action: 'toggleBlock' });
  assert.equal(h.requests.length, 0);
});

test('observations omit passwords, files, actor overrides, URLs and arbitrary form data', async () => {
  const h = harness({ role: 'court_owner' });
  await h.db.recordAdminActivity({ category: 'interaction', action: 'saveCourt', targetId: 'https://private.example?token=secret', actorId: 'forged', password: 'private-password', details: { receipt: 'private-image' }, outcome: 'attempt' });
  const request = h.requests[0];
  assert.equal(request.name, 'record_admin_activity');
  assert.deepEqual(request.args.p_metadata, { action: 'saveCourt', entityType: '', entityId: '', outcome: 'attempt' });
  assert.doesNotMatch(JSON.stringify(request), /private-password|private-image|forged|private.example/);
  await h.db.recordAdminActivity({ category: 'database_change', action: 'forged save' });
  assert.equal(h.requests.length, 1);
});

test('operation wrapper preserves success and failures and records only bounded operation identity', async () => {
  const failure = new Error('Could not save');
  const h = harness({ role: 'court_owner', methods: {
    async saveCourt(court) { return { ok: true, id: court.id }; },
    async deleteCourt() { throw failure; },
  } });
  assert.deepEqual(await h.db.saveCourt({ id: 'c1', password: 'secret', photo: 'private' }), { ok: true, id: 'c1' });
  await assert.rejects(h.db.deleteCourt('c1'), error => error === failure);
  assert.deepEqual(h.requests.map(request => request.args.p_metadata.outcome), ['success', 'failed']);
  assert.doesNotMatch(JSON.stringify(h.requests), /secret|private/);
});

test('navigation records the destination page before the URL changes', async () => {
  const h = harness({ role: 'court_owner' });
  assert.equal(h.context.location.hash, '#courts');
  await h.db.recordAdminActivity({ category: 'navigation', action: 'page_view', targetType: 'section', targetId: 'accounts', outcome: 'view' });
  assert.equal(h.requests[0].args.p_event, 'page_view');
  assert.equal(h.requests[0].args.p_page, 'accounts');
  assert.equal(h.requests[0].args.p_metadata.entityId, 'accounts');
  await h.db.recordAdminActivity({ category: 'navigation', action: 'page_view', page: 'bookings', outcome: 'view' });
  assert.equal(h.requests[1].args.p_page, 'bookings');
  await h.db.recordAdminActivity({ category: 'interaction', action: 'saveCourt', targetId: 'c1', outcome: 'attempt' });
  assert.equal(h.requests[2].args.p_page, 'courts');
});

test('operation results keep their starting page after navigation, including failures', async () => {
  let finish;
  const h = harness({ role: 'court_owner', methods: {
    async saveHostAccount() { return new Promise((resolve, reject) => { finish = { resolve, reject }; }); },
  } });
  h.context.location.hash = '#accounts';
  const saved = h.db.saveHostAccount({ id: 'host-1' });
  h.context.location.hash = '#bookings';
  finish.resolve({ ok: true });
  assert.deepEqual(await saved, { ok: true });
  assert.equal(h.requests[0].args.p_page, 'accounts');
  assert.equal(h.requests[0].args.p_metadata.outcome, 'success');

  h.context.location.hash = '#accounts';
  const failed = h.db.saveHostAccount({ id: 'host-1' });
  h.context.location.hash = '#dash';
  const failure = new Error('Could not save account');
  finish.reject(failure);
  await assert.rejects(failed, error => error === failure);
  assert.equal(h.requests[1].args.p_page, 'accounts');
  assert.equal(h.requests[1].args.p_metadata.outcome, 'failed');
});

test('operation results are not attributed to a replacement signed-in account', async () => {
  let finish;
  const h = harness({ methods: { async saveHostAccount() { return new Promise(resolve => { finish = resolve; }); } } });
  h.context.location.hash = '#accounts';
  const pending = h.db.saveHostAccount({ id: 'host-1' });
  h.setSession({ id: 'actor-2', role: 'owner', status: 'active' });
  h.context.location.hash = '#dash';
  finish({ ok: true });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(h.requests.length, 0);
});

test('missing URL hashes do not interrupt observed or unobserved operations', async () => {
  for (const options of [{}, { local: true }, { privateSurface: false }, { role: 'host' }]) {
    const h = harness({ ...options, methods: { async saveCourt() { return { ok: true }; } } });
    delete h.context.location.hash;
    assert.deepEqual(await h.db.saveCourt({ id: 'c1' }), { ok: true });
    if (!Object.keys(options).length) {
      assert.equal(h.requests[0].args.p_page, 'admin');
    } else {
      assert.equal(h.requests.length, 0);
    }
  }
});

test('observation failure never changes the original business-operation result', async () => {
  const h = harness({ rpc: async () => { throw new Error('Audit offline'); }, methods: { async saveSetting() { return true; } } });
  assert.equal(await h.db.saveSetting('open_hour', '17'), true);
});

test('cache invalidation stays synchronous and creates no operator event', () => {
  const clearCache = () => true;
  const h = harness({ methods: { clearCache } });
  assert.equal(h.db.clearCache, clearCache);
  assert.equal(h.db.clearCache(), true);
  assert.equal(h.requests.length, 0);
});

test('void and false results never claim a successful operation', async () => {
  const h = harness({ methods: {
    async addBlockedDate() {}, async removeBlockedDate() { return null; },
    async updateBooking() { return false; },
  } });
  await h.db.addBlockedDate('2026-09-09');
  await h.db.removeBlockedDate('2026-09-09');
  await h.db.updateBooking('B1');
  assert.deepEqual(h.requests.map(request => request.args.p_metadata.outcome), ['attempt', 'attempt', 'failed']);
});

test('server failures are surfaced as unavailable rather than empty history', async () => {
  const h = harness({ rpc: async () => ({ error: { message: 'Permission denied' } }) });
  await assert.rejects(h.db.getAdminActivity(), /Permission denied/);
});

test('only supported control events and verified UI result names reach activity metadata', async () => {
  const h = harness();
  for (const [controlEvent, uiResult] of [
    ['click', 'opened'], ['click', 'closed'], ['change', 'expanded'],
    ['click', 'collapsed'], ['submit', 'validation_failed'],
  ]) {
    await h.db.recordAdminActivity({ category: 'result', action: 'court_editor_open', controlEvent, uiResult, outcome: 'success' });
    const metadata = h.requests.at(-1).args.p_metadata;
    assert.equal(metadata.controlEvent, controlEvent);
    assert.equal(metadata.uiResult, uiResult);
  }
  await h.db.recordAdminActivity({ category: 'result', action: 'saveCourt', controlEvent: 'input', uiResult: 'private-form-contents', value: 'secret', details: { password: 'hidden' } });
  assert.equal(Object.hasOwn(h.requests.at(-1).args.p_metadata, 'controlEvent'), false);
  assert.equal(Object.hasOwn(h.requests.at(-1).args.p_metadata, 'uiResult'), false);
  assert.doesNotMatch(JSON.stringify(h.requests), /private-form-contents|secret|hidden/);
});

test('staff actions are recorded while history stays system-owner-only', async () => {
  const h = harness({ role: 'staff', methods: { async confirmBooking() { return { ok: true }; } } });
  await h.db.recordAdminActivity({ category: 'navigation', action: 'page_view', targetId: 'bookings', outcome: 'view' });
  await h.db.confirmBooking('B1');
  assert.deepEqual(h.requests.map(request => request.args.p_metadata.outcome), ['view', 'success']);
  await assert.rejects(h.db.getAdminActivity(), /Only the system owner/);
  await assert.rejects(h.db.getAdminActivityDetail('1'), /Only the system owner/);
  assert.equal(h.requests.length, 2);
  for (const options of [{ role: 'host' }, { privateSurface: false }, { local: true }]) {
    const hidden = harness(options);
    await hidden.db.recordAdminActivity({ category: 'interaction', action: 'saveCourt' });
    assert.equal(hidden.requests.length, 0);
  }
});

test('account result observers preserve success, explicit failure, throws and unknown results without account fields', async () => {
  const failure = new Error('private-account-error');
  let result = { ok: true };
  const changePassword = async () => ({ ok: true });
  const h = harness({ authMethods: {
    async add() { return result; },
    async update() { return { ok: false, msg: 'private-account-error' }; },
    async del() { throw failure; },
    changePassword,
  } });
  const account = { password: 'private-password', email: 'private@example.com', fullName: 'private-name', id: 'forged-id' };
  assert.equal(await h.auth.add(account), result);
  assert.deepEqual(await h.auth.update('account-1', account), { ok: false, msg: 'private-account-error' });
  await assert.rejects(h.auth.del('account-2'), error => error === failure);
  result = undefined;
  assert.equal(await h.auth.add(account), undefined);
  assert.deepEqual(h.requests.map(request => request.args.p_metadata.outcome), ['success', 'failed', 'failed', 'attempt']);
  assert.deepEqual(h.requests.map(request => request.args.p_metadata.action), ['createAccount', 'updateAccount', 'deleteAccount', 'createAccount']);
  assert.deepEqual(h.requests.map(request => request.args.p_metadata.entityId), ['', 'account-1', 'account-2', '']);
  assert.ok(h.requests.every(request => request.args.p_metadata.entityType === 'accounts'));
  assert.doesNotMatch(JSON.stringify(h.requests), /private|forged-id/);
  assert.equal(h.auth.changePassword, changePassword, 'Existing password recording must not be wrapped again');
  assert.match(source, /_pbInstallAccountActivityObservers\(window\.Auth, window\.DB\);/);
});

test('account result observers retain their starting page and never attribute results to another session', async () => {
  let finish;
  const h = harness({ authMethods: { async update() { return new Promise(resolve => { finish = resolve; }); } } });
  h.context.location.hash = '#accounts';
  const pending = h.auth.update('account-1', { password: 'not-recorded' });
  h.context.location.hash = '#dash';
  finish({ ok: true });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(h.requests[0].args.p_page, 'accounts');

  const replaced = h.auth.update('account-2', {});
  h.setSession({ id: 'actor-2', role: 'owner', status: 'active' });
  finish({ ok: true });
  await replaced;
  assert.equal(h.requests.length, 1);

  const unsafe = harness({ authMethods: { async update() { return { ok: true }; } } });
  await unsafe.auth.update('https://example.com?token=secret', {});
  assert.equal(unsafe.requests[0].args.p_metadata.entityId, '');
  assert.doesNotMatch(JSON.stringify(unsafe.requests), /example|secret/);
});

test('account operations are unaffected by audit failures and do not record on public or demo pages', async () => {
  const ok = { ok: true };
  const failedAudit = harness({ rpc: async () => { throw new Error('Audit unavailable'); }, authMethods: { async add() { return ok; } } });
  assert.equal(await failedAudit.auth.add({ password: 'hidden' }), ok);
  for (const options of [{ privateSurface: false }, { local: true }, { role: 'host' }]) {
    const h = harness({ ...options, authMethods: { async add() { return ok; } } });
    assert.equal(await h.auth.add({ password: 'hidden' }), ok);
    assert.equal(h.requests.length, 0);
  }
});

test('successful dashboard sign-ins are recorded only on the actual login page', async () => {
  const signIn = { category: 'sign_in', action: 'signIn', page: 'login', outcome: 'success' };
  for (const pathname of ['/login', '/login.html', '/login/']) {
    for (const role of ['owner', 'court_owner', 'staff']) {
      const h = harness({ role, privateSurface: false });
      h.context.location.pathname = pathname;
      await h.db.recordAdminActivity(signIn);
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].args.p_event, 'sign_in');
      assert.equal(h.requests[0].args.p_page, 'login');
      assert.equal(h.requests[0].args.p_metadata.outcome, 'success');
      await assert.rejects(h.db.getAdminActivity(), /Only the system owner/);
    }
  }
  for (const pathname of ['/', '/index.html', '/bookings', '/other/login.html', '/login-copy.html']) {
    const h = harness({ privateSurface: false });
    h.context.location.pathname = pathname;
    await h.db.recordAdminActivity(signIn);
    assert.equal(h.requests.length, 0);
  }
  for (const override of [
    { category: 'interaction' }, { action: 'saveCourt' }, { page: 'accounts' },
    { outcome: 'failed' }, { outcome: 'attempt' },
  ]) {
    const h = harness({ privateSurface: false });
    h.context.location.pathname = '/login.html';
    await h.db.recordAdminActivity({ ...signIn, ...override });
    assert.equal(h.requests.length, 0);
  }
  for (const options of [{ role: 'host' }, { role: null }, { local: true }]) {
    const h = harness({ ...options, privateSurface: false });
    h.context.location.pathname = '/login.html';
    await h.db.recordAdminActivity(signIn);
    assert.equal(h.requests.length, 0);
  }
  const inactive = harness({ privateSurface: false });
  inactive.context.location.pathname = '/login.html';
  inactive.setSession({ id: 'actor-1', role: 'owner', status: 'suspended' });
  await inactive.db.recordAdminActivity(signIn);
  assert.equal(inactive.requests.length, 0);
});
