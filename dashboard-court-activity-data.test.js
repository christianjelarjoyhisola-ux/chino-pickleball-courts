const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function functionSource(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `${name} must exist`);
  return match[0];
}
function methodSource(local) {
  const indent = local ? '    ' : '  ';
  const match = source.match(new RegExp(`^${indent}async getCourtActivityBookings\\(\\) \\{[\\s\\S]*?^${indent}\\},`, 'm'));
  assert.ok(match, `${local ? 'local' : 'production'} court activity method must exist`);
  return match[0];
}
function rawBooking(overrides = {}) {
  return {
    ref: 'B-1', booking_group_ref: 'G-1', full_name: 'Anna Mae', email: 'anna@example.com',
    court_id: 'c1', court_name: 'Court 1', date: '2026-09-09', slots: [9, 10],
    start_time: '9:00 AM', end_time: '11:00 AM', duration: '2', status: 'confirmed', ...overrides,
  };
}
function harness({ local = false, role = 'owner', status = 'active', privateSurface = true,
  now = '2026-09-08T16:30:00Z', pages = [{ data: [], error: null }], bookings = [], roleError = null } = {}) {
  const requests = [];
  let roleReads = 0;
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return new NativeDate(now).getTime(); }
  }
  const client = {
    from(table) {
      const request = { table, orders: [] };
      const query = {
        select(columns) { request.columns = columns; return query; },
        gte(column, value) { request.lower = [column, value]; return query; },
        lte(column, value) { request.upper = [column, value]; return query; },
        in(column, values) { request.states = [column, plain(values)]; return query; },
        order(column, options) { request.orders.push([column, plain(options)]); return query; },
        async range(from, to) {
          request.range = [from, to];
          requests.push(request);
          return pages[Math.floor(from / 1000)] ?? { data: [], error: null };
        },
      };
      return query;
    },
  };
  const context = vm.createContext({
    Date: FixedDate, Intl, PB_PRIVATE_DATA_SURFACE: privateSurface, _sb: client,
    _pbCurrentAccountRole: async () => { roleReads += 1; if (roleError) throw roleError; return role; },
    _pbCached: () => { throw new Error('Court activity must bypass shared booking cache.'); },
    window: { Auth: { getSession: () => role === null ? null : { role, status } } },
    readDb: () => ({ bookings }),
  });
  vm.runInContext(
    ['_pbManilaToday', '_pbCourtActivityWindow', '_pbCourtActivityBooking'].map(functionSource).join('\n')
      + `\nthis.read = ({${methodSource(local)}}).getCourtActivityBookings;`, context,
  );
  return { read: () => context.read(), requests, roleReads: () => roleReads };
}

test('court activity reads only the Philippine operational dates and normalized operational fields', async () => {
  const h = harness({ pages: [{ data: [rawBooking({ total: 530, gcash_ref: 'private', receipt_image_url: 'private' })], error: null }] });
  const result = plain(await h.read());
  assert.deepEqual(h.requests[0], {
    table: 'bookings',
    columns: 'ref,booking_group_ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,status',
    lower: ['date', '2026-09-08'], upper: ['date', '2026-09-15'],
    states: ['status', ['confirmed', 'pending', 'verifying']],
    orders: [['date', { ascending: true }], ['ref', { ascending: true }]], range: [0, 999],
  });
  assert.deepEqual(result, [{
    ref: 'B-1', groupRef: 'G-1', fullName: 'Anna Mae', email: 'anna@example.com', courtId: 'c1', courtName: 'Court 1',
    date: '2026-09-09', slots: [9, 10], startTime: '9:00 AM', endTime: '11:00 AM', duration: 2, status: 'confirmed',
  }]);
});

test('court activity follows Philippine calendar boundaries across the year', async () => {
  const h = harness({ now: '2026-12-31T16:30:00Z' });
  await h.read();
  assert.deepEqual(h.requests[0].lower, ['date', '2026-12-31']);
  assert.deepEqual(h.requests[0].upper, ['date', '2027-01-07']);
});

test('every page is read with stable ordering instead of truncating at one thousand bookings', async () => {
  const first = Array.from({ length: 1000 }, (_, index) => rawBooking({ ref: `B-${index}` }));
  const second = [rawBooking({ ref: 'B-1000' }), rawBooking({ ref: 'B-1001' })];
  const h = harness({ pages: [{ data: first }, { data: second }] });
  const rows = await h.read();
  assert.equal(rows.length, 1002);
  assert.equal(rows[1001].ref, 'B-1001');
  assert.deepEqual(h.requests.map(request => request.range), [[0, 999], [1000, 1999]]);
  assert.deepEqual(h.requests[1].orders, h.requests[0].orders);
  assert.deepEqual(h.requests[1].lower, h.requests[0].lower);
});

test('backend, account lookup, and partial pagination errors propagate without an empty success result', async () => {
  const failure = new Error('Connection unavailable');
  const h = harness({ pages: [{ data: Array.from({ length: 1000 }, (_, i) => rawBooking({ ref: `B-${i}` })) }, { data: null, error: failure }] });
  await assert.rejects(h.read(), error => error === failure);
  assert.equal(h.requests.length, 2);
  await assert.rejects(harness({ pages: [{ data: null, error: failure }] }).read(), error => error === failure);
  await assert.rejects(harness({ roleError: failure }).read(), error => error === failure);
  await assert.rejects(harness({ pages: [{ data: null }] }).read(), /invalid response/);
});

test('court activity rejects public pages and non-dashboard roles before reading private bookings', async () => {
  for (const settings of [{ privateSurface: false }, { role: 'host' }, { role: '' }, { role: null }, { role: 'customer' }]) {
    const h = harness(settings);
    await assert.rejects(h.read(), /active dashboard account/);
    assert.equal(h.requests.length, 0);
  }
  for (const role of ['owner', 'court_owner', 'staff']) {
    const h = harness({ role });
    assert.deepEqual(plain(await h.read()), []);
    assert.equal(h.requests.length, 1);
  }
});

test('each activity refresh reaches the backend rather than a cached general booking list', async () => {
  const h = harness();
  await h.read();
  await h.read();
  assert.equal(h.requests.length, 2);
  assert.equal(h.roleReads(), 2);
});

test('local data applies the same date/status window and returns detached minimal normalized fields', async () => {
  const local = {
    ref: 'today', groupRef: 'G', fullName: 'Anna', email: 'anna@example.com', courtId: 'c1', courtName: 'Court 1',
    date: '2026-09-09', slots: [9], startTime: '9:00 AM', endTime: '10:00 AM', duration: 1, status: 'confirmed',
    total: 265, receiptImageUrl: 'private',
  };
  const bookings = [
    local,
    { ...local, ref: 'last-day', date: '2026-09-15', status: 'pending' },
    { ...local, ref: 'yesterday', date: '2026-09-08', status: 'verifying' },
    { ...local, ref: 'too-old', date: '2026-09-07' },
    { ...local, ref: 'too-far', date: '2026-09-16' },
    ...['cancelled', 'completed', 'forfeited', 'rejected'].map(status => ({ ...local, ref: status, status })),
  ];
  const h = harness({ local: true, bookings });
  const result = await h.read();
  assert.deepEqual(plain(result.map(row => row.ref)), ['yesterday', 'today', 'last-day']);
  assert.equal(result[1].groupRef, 'G');
  assert.equal(Object.hasOwn(result[1], 'total'), false);
  assert.equal(Object.hasOwn(result[1], 'receiptImageUrl'), false);
  result[1].slots.push(10);
  assert.deepEqual(local.slots, [9]);
  assert.equal(h.requests.length, 0);
});

test('local activity blocks unauthorized and inactive sessions on the same private surface', async () => {
  for (const settings of [{ role: null }, { role: 'host' }, { status: 'suspended' }, { status: 'pending' }, { privateSurface: false }]) {
    await assert.rejects(harness({ local: true, ...settings }).read(), /active dashboard account/);
  }
  for (const role of ['owner', 'court_owner', 'staff']) {
    assert.deepEqual(plain(await harness({ local: true, role }).read()), []);
  }
});
