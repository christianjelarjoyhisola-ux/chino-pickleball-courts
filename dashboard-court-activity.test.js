const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshot } = require('./dashboard-court-activity');

const now = new Date('2026-09-09T09:00:00+08:00');
function booking(overrides = {}) {
  return {
    ref: 'B-1', courtId: 'c1', courtName: 'Court 1', fullName: 'Anna Mae',
    date: '2026-09-09', startTime: '9:00 AM', endTime: '10:00 AM',
    duration: 1, status: 'confirmed', email: 'anna@example.com', ...overrides,
  };
}

test('a session starts exactly on its boundary and ends exclusively', () => {
  const rows = [booking()];
  assert.equal(buildSnapshot(rows, { now: '2026-09-09T08:59:59+08:00' }).next.length, 1);
  const current = buildSnapshot(rows, { now });
  assert.equal(current.playing.length, 1);
  assert.equal(current.playing[0].minutesUntilEnd, 60);
  assert.equal(buildSnapshot(rows, { now: '2026-09-09T10:00:00+08:00' }).playing.length, 0);
});

test('today and overnight play follow Philippine time across UTC midnight', () => {
  const rows = [booking({ date: '2026-09-08', startTime: '11:00 PM', endTime: '1:00 AM' })];
  const snapshot = buildSnapshot(rows, { now: '2026-09-08T16:15:00Z' });
  assert.equal(snapshot.today, '2026-09-09');
  assert.equal(snapshot.playing.length, 1);
  assert.equal(snapshot.playing[0].date, '2026-09-08');
  assert.equal(snapshot.playing[0].minutesUntilEnd, 45);
  assert.equal(buildSnapshot(rows, { now: '2026-09-08T17:00:00Z' }).playing.length, 0);
});

test('12 AM, 12 PM, 24-hour SQL times and midnight end parse unambiguously', () => {
  const rows = [
    booking({ ref: 'midnight', startTime: '12:00 AM', endTime: '01:00:00' }),
    booking({ ref: 'noon', startTime: '12:00 PM', endTime: '13:00:00' }),
    booking({ ref: 'late', startTime: '23:00', endTime: '24:00' }),
  ];
  const snapshot = buildSnapshot(rows, { now: '2026-09-09T00:30:00+08:00' });
  assert.equal(snapshot.playing[0].ref, 'midnight');
  assert.equal(snapshot.next[0].ref, 'noon');
  assert.equal(snapshot.upcoming[0].endMs, Date.parse('2026-09-10T00:00:00+08:00'));
});

test('only confirmed bookings play; genuine pending reviews are counted separately', () => {
  const rows = [
    booking({ ref: 'manual', email: 'walkin@manual.internal' }),
    ...['pending', 'verifying', 'completed', 'cancelled', 'forfeited', 'rejected', 'unknown'].map(status => booking({ ref: status, status })),
    booking({ ref: 'hold-email', email: 'reserve@hold.internal' }),
    booking({ ref: 'hold-name', fullName: 'Reserving...' }),
    booking({ ref: 'hold-unicode', fullName: 'Reserving…' }),
  ];
  const snapshot = buildSnapshot(rows, { now });
  assert.deepEqual(snapshot.playing.map(row => row.ref), ['manual']);
  assert.deepEqual(snapshot.pending.map(row => row.ref), ['pending', 'verifying']);
  assert.deepEqual(snapshot.counts, { playing: 1, next: 0, upcoming: 0, pending: 2 });
});

test('next includes the whole first start wave, with later starts separated', () => {
  const rows = [
    booking({ ref: 'later', startTime: '11:00 AM', endTime: '12:00 PM' }),
    booking({ ref: 'court10', courtName: 'Court 10', courtId: 'c10', startTime: '10:00 AM', endTime: '11:00 AM' }),
    booking({ ref: 'court2', courtName: 'Court 2', courtId: 'c2', startTime: '10:00 AM', endTime: '11:00 AM' }),
  ];
  const snapshot = buildSnapshot(rows, { now });
  assert.deepEqual(snapshot.next.map(row => row.ref), ['court2', 'court10']);
  assert.equal(snapshot.next[0].minutesUntilStart, 60);
  assert.deepEqual(snapshot.upcoming.map(row => row.ref), ['later']);
});

test('upcoming is bounded to today and the next six Philippine calendar dates', () => {
  const rows = [
    booking({ ref: 'tomorrow', date: '2026-09-10' }),
    booking({ ref: 'last-day', date: '2026-09-15', startTime: '11:00 PM', endTime: '12:00 AM' }),
    booking({ ref: 'outside', date: '2026-09-16', startTime: '12:00 AM', endTime: '1:00 AM' }),
    booking({ ref: 'past', date: '2026-09-08' }),
    booking({ ref: 'expired-review', date: '2026-09-08', status: 'pending' }),
  ];
  const snapshot = buildSnapshot(rows, { now });
  assert.deepEqual(snapshot.next.map(row => row.ref), ['tomorrow']);
  assert.deepEqual(snapshot.upcoming.map(row => row.ref), ['last-day']);
  assert.deepEqual(snapshot.pending, []);
});

test('contiguous confirmed rows in one booking group become one ongoing court session', () => {
  const rows = [
    booking({ ref: 'second', groupRef: 'G-1', startTime: '10:00 AM', endTime: '11:00 AM' }),
    booking({ ref: 'first', groupRef: 'G-1' }),
    booking({ ref: 'third', groupRef: 'G-1', startTime: '11:00 AM', endTime: '12:00 PM' }),
  ];
  const snapshot = buildSnapshot(rows, { now: '2026-09-09T10:30:00+08:00' });
  assert.equal(snapshot.playing.length, 1);
  assert.equal(snapshot.playing[0].ref, 'first');
  assert.equal(snapshot.playing[0].startLabel, '9:00 AM');
  assert.equal(snapshot.playing[0].endLabel, '12:00 PM');
  assert.equal(snapshot.playing[0].minutesUntilEnd, 90);
  assert.equal(snapshot.next.length, 0);
});

test('different courts, people, groups and noncontiguous slots remain distinct', () => {
  const rows = [
    booking({ ref: 'first', groupRef: 'G-1' }),
    booking({ ref: 'court2', groupRef: 'G-1', courtId: 'c2', courtName: 'Court 2' }),
    booking({ ref: 'other-person', groupRef: 'G-1', fullName: 'Ben', email: 'ben@example.com' }),
    booking({ ref: 'other-group', groupRef: 'G-2', startTime: '10:00 AM', endTime: '11:00 AM' }),
    booking({ ref: 'gap', groupRef: 'G-1', startTime: '11:00 AM', endTime: '12:00 PM' }),
  ];
  const snapshot = buildSnapshot(rows, { now });
  assert.equal(snapshot.playing.length, 3);
  assert.deepEqual(snapshot.next.map(row => row.ref), ['other-group']);
  assert.deepEqual(snapshot.upcoming.map(row => row.ref), ['gap']);
});

test('unidentified adjacent bookings are not silently merged and ref-less rows survive deduplication', () => {
  const first = booking();
  const rows = [first, { ...first }, booking({ ref: '', courtId: 'c2', courtName: 'Court 2' }), booking({ ref: '', courtId: 'c3', courtName: 'Court 3' }), booking({ ref: 'next', startTime: '10:00 AM', endTime: '11:00 AM' })];
  const snapshot = buildSnapshot(rows, { now });
  assert.equal(snapshot.playing.length, 3);
  assert.equal(snapshot.next.length, 1);
});

test('duration fills a missing end and can cross midnight', () => {
  const rows = [booking({ startTime: '11:30 PM', endTime: '', duration: 1.5 })];
  const snapshot = buildSnapshot(rows, { now: '2026-09-10T00:15:00+08:00' });
  assert.equal(snapshot.playing[0].endLabel, '1:00 AM');
  assert.equal(snapshot.playing[0].minutesUntilEnd, 45);
});

test('noncontiguous explicit hours do not imply playing during the unbooked gap', () => {
  const row = booking({ slots: ['12', '9', '11', '11'], startTime: '9:00 AM', endTime: '1:00 PM', duration: 3 });
  const during = buildSnapshot([row, { ...row }], { now: '2026-09-09T09:30:00+08:00' });
  assert.equal(during.playing.length, 1);
  assert.equal(during.playing[0].endLabel, '10:00 AM');
  assert.equal(during.next.length, 1);
  assert.equal(during.next[0].startLabel, '11:00 AM');
  assert.equal(during.next[0].endLabel, '1:00 PM');
  const gap = buildSnapshot([row], { now: '2026-09-09T10:30:00+08:00' });
  assert.equal(gap.playing.length, 0);
  assert.equal(gap.next.length, 1);
});

test('slot groups merge across adjacent group rows and reject malformed explicit hours', () => {
  const rows = [
    booking({ ref: 'first', groupRef: 'G', slots: [9, 11] }),
    booking({ ref: 'bridge', groupRef: 'G', slots: [10] }),
    booking({ ref: 'bad-hour', slots: [9, 24] }),
    booking({ ref: 'bad-empty', slots: [9, ''] }),
  ];
  const snapshot = buildSnapshot(rows, { now });
  assert.equal(snapshot.playing.length, 1);
  assert.equal(snapshot.playing[0].ref, 'first');
  assert.equal(snapshot.playing[0].endLabel, '12:00 PM');
  assert.equal(snapshot.next.length, 0);
});

test('malformed dates and times never become believable court activity', () => {
  const malformed = [
    { date: '2026-02-30' }, { date: 'not-a-date' }, { date: '2026-09-09T00:00:00' },
    { startTime: '13:00 PM' }, { startTime: '9:75 AM' }, { startTime: '24:00' },
    { startTime: '' }, { endTime: '10:99 AM' }, { endTime: 'tomorrow' },
    { endTime: '', duration: -1 }, { endTime: '', duration: 'unknown' },
    { endTime: '9:00 AM', duration: 0 },
  ];
  const rows = malformed.map((overrides, i) => booking({ ref: `invalid-${i}`, ...overrides }));
  const snapshot = buildSnapshot(rows, { now });
  assert.deepEqual(snapshot.counts, { playing: 0, next: 0, upcoming: 0, pending: 0 });
  assert.throws(() => buildSnapshot([], { now: 'invalid' }), /valid current time/);
});

test('input is unchanged and output exposes operational fields without payment details', () => {
  const original = booking({ total: 265, gcashRef: '123456', receiptUrl: 'private', contactNumber: '09123456789' });
  Object.freeze(original);
  const snapshot = buildSnapshot(Object.freeze([original]), { now });
  for (const key of ['total', 'gcashRef', 'receiptUrl', 'contactNumber', 'email', '_mergeKey']) {
    assert.equal(Object.hasOwn(snapshot.playing[0], key), false, `${key} stays out of the operational snapshot`);
  }
  assert.equal(original.endTime, '10:00 AM');
  assert.deepEqual(buildSnapshot(null, { now }).counts, { playing: 0, next: 0, upcoming: 0, pending: 0 });
});
