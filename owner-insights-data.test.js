const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function functionSource(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `${name} must exist`);
  return match[0];
}

function methodSource(name, local) {
  const indent = local ? '    ' : '  ';
  const match = source.match(new RegExp(`^${indent}async ${name}\\(\\) \\{[\\s\\S]*?^${indent}\\},`, 'm'));
  assert.ok(match, `${local ? 'local' : 'production'} ${name} must exist`);
  return match[0];
}

function booking(overrides = {}) {
  return {
    ref: 'B1', booking_group_ref: 'G1', court_id: 'c1', date: '2026-09-13', slots: [17, 18],
    start_time: '5:00 PM', end_time: '7:00 PM', duration: '2', status: 'confirmed',
    payment_status: 'paid', created_at: '2026-09-09T01:00:00Z',
    email: 'customer@example.com', full_name: 'Customer Name', ...overrides,
  };
}

function harness({ local = false, role = 'owner', status = 'active', privateSurface = true,
  tables = {}, pages = {}, roleError = null, localDb = {} } = {}) {
  const requests = [];
  let roleReads = 0;
  const rows = { bookings: [], courts: [], settings: [], blocked_dates: [], ...tables };
  const db = { bookings: [], courts: [], settings: {}, blockedDates: [], ...localDb };
  const client = {
    from(table) {
      const request = { table, orders: [] };
      const query = {
        select(columns) { request.columns = columns; return query; },
        order(column, options) { request.orders.push([column, plain(options)]); return query; },
        async range(from, to) {
          request.range = [from, to];
          requests.push(request);
          return pages[table]?.[Math.floor(from / 1000)] ?? { data: rows[table].slice(from, to + 1), error: null };
        },
      };
      return query;
    },
  };
  const context = vm.createContext({
    _sb: client, PB_PRIVATE_DATA_SURFACE: privateSurface,
    _pbCurrentAccountRole: async () => { roleReads += 1; if (roleError) throw roleError; return role; },
    _pbCached: () => { throw new Error('Insights must not use the shared display cache.'); },
    _pbClone: value => structuredClone(value),
    window: { Auth: { getSession: () => role === null ? null : { role, status } } },
    readDb: () => db,
  });
  vm.runInContext(
    ['_pbInsightBooking', '_pbReadInsightRows', 'rowToCourt'].map(functionSource).join('\n')
    + `\nthis.adapter = {${methodSource('getInsightBookings', local)}${methodSource('getInsightInputs', local)}};`, context,
  );
  return { adapter: context.adapter, requests, rows, db, roleReads: () => roleReads };
}

test('Insights reads complete normalized booking and schedule inputs without customer details in results', async () => {
  const h = harness({ tables: {
    bookings: [booking({ receipt_image_url: 'private receipt', contact_number: 'private phone' })],
    courts: [{ id: 'c1', name: 'Court 1', rate: 265, rate_schedule: { openHour: 8 }, created_at: '2026-01-01' }],
    settings: [{ key: 'open_hour', value: '8' }, { key: 'close_hour', value: '22' }],
    blocked_dates: [{ date: '2026-09-14' }],
  } });
  const result = plain(await h.adapter.getInsightInputs());
  assert.deepEqual(result.bookings, [{
    ref: 'B1', groupRef: 'G1', courtId: 'c1', date: '2026-09-13', slots: [17, 18],
    startTime: '5:00 PM', endTime: '7:00 PM', duration: 2, status: 'confirmed',
    paymentStatus: 'paid', createdAt: '2026-09-09T01:00:00Z', isTemporaryHold: false,
  }]);
  assert.equal(result.courts[0].name, 'Court 1');
  assert.deepEqual(result.courts[0].rateSchedule, { openHour: 8 });
  assert.deepEqual(result.settings, { open_hour: '8', close_hour: '22' });
  assert.deepEqual(result.blockedDates, ['2026-09-14']);
  const columns = h.requests.find(request => request.table === 'bookings').columns;
  assert.doesNotMatch(columns, /receipt|contact|gcash|total/);
  assert.doesNotMatch(JSON.stringify(result.bookings), /customer@example|Customer Name|private receipt|private phone/);
});

test('Insights distinguishes server placeholders from real verifying bookings using both identity fields', async () => {
  const h = harness({ tables: { bookings: [
    booking({ ref: 'placeholder', status: 'verifying', email: ' reserve@hold.internal ', full_name: ' RESERVING... ' }),
    booking({ ref: 'unicode-placeholder', status: 'verifying', email: 'reserve@hold.internal', full_name: 'Reserving…' }),
    booking({ ref: 'real-verifying', status: 'verifying' }),
    booking({ ref: 'email-only', email: 'reserve@hold.internal' }),
    booking({ ref: 'name-only', full_name: 'Reserving...' }),
  ] } });
  const result = plain(await h.adapter.getInsightBookings());
  assert.deepEqual(result.map(row => row.isTemporaryHold), [true, true, false, false, false]);
  assert.equal(result.find(row => row.ref === 'real-verifying').status, 'verifying');
});

test('malformed slot evidence is preserved for rejection rather than converted to a legacy fallback', async () => {
  const h = harness({ tables: { bookings: [
    booking({ ref: 'malformed', slots: 'not an array' }),
    booking({ ref: 'legacy', slots: null }),
  ] } });
  const result = plain(await h.adapter.getInsightBookings());
  assert.equal(result[0].slots, 'not an array');
  assert.deepEqual(result[1].slots, []);
});

test('booking pages have stable unique ordering and are not capped at one thousand rows', async () => {
  const h = harness({ tables: { bookings: Array.from({ length: 1002 }, (_, index) => booking({ ref: `B-${index}` })) } });
  assert.equal((await h.adapter.getInsightBookings()).length, 1002);
  assert.deepEqual(h.requests.map(request => request.range), [[0, 999], [1000, 1999]]);
  for (const request of h.requests) {
    assert.deepEqual(request.orders, [['created_at', { ascending: false }], ['ref', { ascending: true }]]);
  }
});

test('court schedules, settings and closures also paginate with their unique keys', async () => {
  const h = harness({ tables: {
    courts: Array.from({ length: 1001 }, (_, id) => ({ id: `C-${id}`, name: `Court ${id}` })),
    settings: Array.from({ length: 1001 }, (_, id) => ({ key: `setting-${id}`, value: String(id) })),
    blocked_dates: Array.from({ length: 1001 }, (_, id) => ({ date: `date-${id}` })),
  } });
  const result = await h.adapter.getInsightInputs();
  assert.equal(result.courts.length, 1001);
  assert.equal(Object.keys(result.settings).length, 1001);
  assert.equal(result.blockedDates.length, 1001);
  for (const [table, key] of [['courts', 'id'], ['settings', 'key'], ['blocked_dates', 'date']]) {
    const requests = h.requests.filter(request => request.table === table);
    assert.deepEqual(requests.map(request => request.range), [[0, 999], [1000, 1999]]);
    assert.deepEqual(requests[1].orders, [[key, { ascending: true }]]);
  }
});

test('failure of any Insights dependency rejects instead of substituting an empty success', async () => {
  for (const table of ['bookings', 'courts', 'settings', 'blocked_dates']) {
    const error = new Error(`${table} unavailable`);
    const h = harness({ pages: { [table]: [{ data: null, error }] } });
    await assert.rejects(h.adapter.getInsightInputs(), caught => caught === error);
  }
});

test('partial-page errors and overlapping pages do not expose an incomplete forecast input', async () => {
  const firstPage = Array.from({ length: 1000 }, (_, index) => booking({ ref: `B-${index}` }));
  const error = new Error('second page unavailable');
  await assert.rejects(harness({ pages: { bookings: [{ data: firstPage }, { data: null, error }] } }).adapter.getInsightInputs(), caught => caught === error);
  await assert.rejects(harness({ pages: { bookings: [{ data: firstPage }, { data: [firstPage[0]] }] } }).adapter.getInsightInputs(), /complete bookings list/);
});

test('missing, malformed, or unidentified rows fail closed for every input collection', async () => {
  for (const table of ['bookings', 'courts', 'settings', 'blocked_dates']) {
    for (const data of [null, {}, [null], [{}]]) {
      await assert.rejects(harness({ pages: { [table]: [{ data }] } }).adapter.getInsightInputs(), /invalid .* response|complete .* list/);
    }
  }
});

test('fresh Insights reads bypass display caches and recheck owner access', async () => {
  const h = harness({ tables: { bookings: [booking()] } });
  const first = await h.adapter.getInsightInputs();
  h.rows.bookings.push(booking({ ref: 'new' }));
  h.rows.blocked_dates.push({ date: '2026-09-20' });
  const second = await h.adapter.getInsightInputs();
  assert.equal(first.bookings.length, 1);
  assert.equal(second.bookings.length, 2);
  assert.deepEqual(plain(second.blockedDates), ['2026-09-20']);
  assert.equal(h.requests.length, 8);
  assert.equal(h.roleReads(), 4);
});

test('Insights requires an active owner and private page before reading data', async () => {
  for (const method of ['getInsightInputs', 'getInsightBookings']) {
    for (const settings of [{ privateSurface: false }, { role: '' }, { role: null }, { role: 'staff' }, { role: 'host' }]) {
      const h = harness(settings);
      await assert.rejects(h.adapter[method](), /active owner session/);
      assert.equal(h.requests.length, 0);
    }
    for (const role of ['owner', 'court_owner']) {
      await harness({ role }).adapter[method]();
    }
    const error = new Error('account lookup failed');
    await assert.rejects(harness({ roleError: error }).adapter[method](), caught => caught === error);
  }
});

test('local Insights returns detached minimal data with the same placeholder semantics', async () => {
  const localDb = {
    bookings: [
      { ref: 'Z', groupRef: 'G', courtId: 'c1', date: '2026-09-13', slots: [17], fullName: 'Real Customer', email: 'real@example.com', createdAt: '2026-09-09', status: 'verifying' },
      { ref: 'A', courtId: 'c1', date: '2026-09-13', slots: [18], fullName: 'Reserving…', email: 'reserve@hold.internal', createdAt: '2026-09-09', status: 'verifying' },
    ],
    courts: [{ id: 'c1', rateSchedule: [{ startHour: 8 }] }],
    settings: { open_hour: '8' }, blockedDates: ['2026-09-14'],
  };
  const h = harness({ local: true, localDb });
  const result = await h.adapter.getInsightInputs();
  assert.deepEqual(plain(result.bookings.map(row => row.ref)), ['A', 'Z']);
  assert.deepEqual(plain(result.bookings.map(row => row.isTemporaryHold)), [true, false]);
  assert.doesNotMatch(JSON.stringify(result.bookings), /real@example|Real Customer|reserve@hold.internal/);
  result.bookings[0].slots.push(19);
  result.courts[0].rateSchedule[0].startHour = 10;
  result.settings.open_hour = '10';
  result.blockedDates.push('2026-09-15');
  assert.deepEqual(localDb.bookings[1].slots, [18]);
  assert.equal(localDb.courts[0].rateSchedule[0].startHour, 8);
  assert.equal(localDb.settings.open_hour, '8');
  assert.deepEqual(localDb.blockedDates, ['2026-09-14']);
  assert.deepEqual(plain(await h.adapter.getInsightBookings()), plain((await h.adapter.getInsightInputs()).bookings));
  assert.equal(h.requests.length, 0);
});

test('local Insights applies the same owner-only scope and rejects inactive sessions', async () => {
  for (const method of ['getInsightInputs', 'getInsightBookings']) {
    for (const settings of [{ role: null }, { role: 'staff' }, { role: 'host' }, { status: 'pending' }, { status: 'suspended' }, { privateSurface: false }]) {
      await assert.rejects(harness({ local: true, ...settings }).adapter[method](), /active owner session/);
    }
    for (const role of ['owner', 'court_owner']) {
      await harness({ local: true, role }).adapter[method]();
    }
  }
});
