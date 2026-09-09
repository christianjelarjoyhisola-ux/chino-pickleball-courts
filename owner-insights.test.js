const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Insights = require('./owner-insights.js');

const ROOT = __dirname;
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function addDays(value, amount) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function court(id = 'court-1', name = 'Court 1') {
  return { id, name, rate: 350, blocked: false, createdAt: '2026-01-01T00:00:00Z' };
}

function booking(overrides = {}) {
  return {
    ref: overrides.ref || `PB-${Math.random().toString(36).slice(2)}`,
    groupRef: overrides.groupRef || null,
    courtId: 'court-1',
    date: '2026-08-31',
    slots: [8],
    duration: 1,
    status: 'confirmed',
    paymentStatus: 'paid',
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    now: '2026-09-01T00:30:00+08:00',
    courts: [court()],
    bookings: [],
    blockedDates: [],
    settings: { open_hour: '8', close_hour: '10' },
    openingDate: '2026-01-01',
    ...overrides,
  };
}

test('fresh production data stays explicitly at day zero and invents no forecast', () => {
  const snapshot = Insights.buildSnapshot(baseInput());
  assert.equal(snapshot.period.from, null);
  assert.equal(snapshot.period.learning_days, 0);
  assert.equal(snapshot.kpis.expected_total_fill_pct, null);
  assert.equal(snapshot.kpis.likely_open_hours, null);
  assert.equal(snapshot.recommendation, null);
  assert.equal(snapshot.kpis.booked_next_28_hours, 0);
  assert.ok(snapshot.kpis.sellable_next_28_hours > 0, 'actual upcoming capacity may still be reported');
});

test('pre-opening forecast counts only opening-day onward capacity and advance reservations', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-02T12:00:00+08:00',
    openingDate: '2026-09-19',
    bookings: [
      booking({ ref: 'LEGACY-PREOPEN', date: '2026-09-18', status: 'confirmed', paymentStatus: 'paid' }),
      booking({ ref: 'ADVANCE', date: '2026-09-19', status: 'pending', paymentStatus: 'unpaid', createdAt: '2026-09-02T08:00:00+08:00' }),
    ],
  }));

  assert.equal(snapshot.period.is_preopening, true);
  assert.equal(snapshot.period.forecast_from, '2026-09-19');
  assert.equal(snapshot.period.forecast_to, '2026-09-30');
  assert.equal(snapshot.kpis.sellable_next_28_hours, 24, '12 opening-aware days at 2 hours per day');
  assert.equal(snapshot.kpis.booked_next_28_hours, 1, 'the Sep 19 advance reservation reserves inventory immediately');
  assert.equal(snapshot.period.from, null, 'future reservations do not teach demand');
  assert.equal(snapshot.period.learning_days, 0);
});

test('learning begins after opening-day play and ignores imported pre-opening history', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-20T00:05:00+08:00',
    openingDate: '2026-09-19',
    bookings: [
      booking({ ref: 'PREOPEN', date: '2026-09-18', createdAt: '2026-09-01T00:00:00Z' }),
      booking({ ref: 'OPENING-DAY', date: '2026-09-19', createdAt: '2026-09-02T00:00:00Z' }),
    ],
  }));

  assert.equal(snapshot.period.from, '2026-09-19');
  assert.equal(snapshot.period.to, '2026-09-19');
  assert.equal(snapshot.period.learning_days, 1);
  assert.equal(snapshot.data_quality.successful_booking_rows, 1);
});

test('30 venue days do not overpromise a Court Pick before comparable-weekday evidence is ready', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-10-19T08:00:00+08:00',
    openingDate: '2026-09-19',
    bookings: [booking({ ref: 'OPENING-DAY', date: '2026-09-19' })],
  }));

  assert.equal(snapshot.period.learning_days, 30);
  assert.equal(snapshot.period.recommendation_evidence_ready, false);
  assert.ok(snapshot.period.max_comparable_days < snapshot.period.minimum_recommendation_comparable_days);
  assert.equal(snapshot.recommendation, null);
});

test('Manila midnight includes yesterday but never trains on today', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    bookings: [
      booking({ ref: 'YESTERDAY', date: '2026-08-31' }),
      booking({ ref: 'TODAY', date: '2026-09-01' }),
    ],
  }));
  assert.equal(snapshot.period.to, '2026-08-31');
  assert.equal(snapshot.period.from, '2026-08-31');
  assert.equal(snapshot.period.learning_days, 1);
  assert.equal(snapshot.data_quality.successful_booking_rows, 1);
  assert.equal(snapshot.kpis.booked_next_28_hours, 0, 'today is neither historical evidence nor a future day');
});

test('day-one confirmed play is visible separately from future reservations and demand history', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-01T12:00:00+08:00',
    bookings: [
      booking({ ref: 'TODAY', date: '2026-09-01', slots: [8] }),
      booking({ ref: 'FUTURE', date: '2026-09-02', slots: [8, 9] }),
    ],
  }));
  assert.equal(snapshot.period.today, '2026-09-01');
  assert.equal(snapshot.kpis.confirmed_today_hours, 1);
  assert.equal(snapshot.kpis.confirmed_today_reservations, 1);
  assert.equal(snapshot.kpis.booked_next_28_hours, 2);
  assert.equal(snapshot.period.learning_days, 0);
  assert.equal(snapshot.period.from, null);
  assert.equal(snapshot.kpis.expected_total_fill_pct, null);
  assert.equal(snapshot.data_quality.successful_reservations, 0, 'today does not teach historical demand');
});

test('today counts grouped reservations once while preserving each court-hour and capping overlap', () => {
  const grouped = booking({ ref: 'GROUP-A', groupRef: 'GROUP', date: '2026-09-01', slots: [8, 8, 9] });
  const snapshot = Insights.buildSnapshot(baseInput({
    courts: [court(), court('court-2', 'Court 2')],
    bookings: [
      grouped,
      { ...grouped },
      booking({ ref: 'GROUP-B', groupRef: 'GROUP', courtId: 'court-2', date: '2026-09-01', slots: [8] }),
      booking({ ref: 'GROUP-OVERLAP', groupRef: 'GROUP', date: '2026-09-01', slots: [9] }),
      booking({ ref: 'OTHER', courtId: 'court-2', date: '2026-09-01', slots: [9], status: 'completed', paymentStatus: 'downpayment_paid' }),
    ],
  }));
  assert.equal(snapshot.kpis.confirmed_today_hours, 4);
  assert.equal(snapshot.kpis.confirmed_today_reservations, 2);
});

test('today excludes unpaid rows but preserves confirmed hours overlapping current availability', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    settings: {
      open_hour: '8', close_hour: '11',
      maintenance_config: { rules: [{ enabled: true, mode: 'specific', start: 9, end: 10, dates: ['2026-09-01'] }] },
      open_play_config: { enabled: true, start: 10, end: 11, specificDates: ['2026-09-01'] },
    },
    bookings: [
      booking({ ref: 'VALID', date: '2026-09-01', slots: [8] }),
      booking({ ref: 'HOLD', date: '2026-09-01', status: 'verifying', isTemporaryHold: true }),
      booking({ ref: 'REVIEW', date: '2026-09-01', status: 'verifying', paymentStatus: 'for_verification' }),
      booking({ ref: 'UNPAID', date: '2026-09-01', paymentStatus: 'unpaid' }),
      booking({ ref: 'CANCELLED', date: '2026-09-01', status: 'cancelled' }),
      booking({ ref: 'MAINTENANCE', date: '2026-09-01', slots: [9] }),
      booking({ ref: 'OPENPLAY', date: '2026-09-01', slots: [10] }),
      booking({ ref: 'OUTSIDE', date: '2026-09-01', slots: [7] }),
      booking({ ref: 'MISSING-COURT', date: '2026-09-01', courtId: 'unknown' }),
    ],
  }));
  assert.equal(snapshot.kpis.confirmed_today_hours, 4);
  assert.equal(snapshot.kpis.confirmed_today_reservations, 4);
  assert.equal(snapshot.data_quality.today_schedule_conflict_hours, 3, 'maintenance, Open Play and outside-hours conflicts remain visible');
});

test('today honors court filtering, opening date and court existence without hiding blocked bookings', () => {
  const input = baseInput({
    courts: [court(), court('court-2', 'Court 2')],
    bookings: [
      booking({ ref: 'A', date: '2026-09-01', slots: [8, 9] }),
      booking({ ref: 'B', date: '2026-09-01', courtId: 'court-2', slots: [9] }),
    ],
  });
  const filtered = Insights.buildSnapshot({ ...input, courtId: 'court-2' });
  assert.equal(filtered.kpis.confirmed_today_hours, 1);
  assert.equal(filtered.kpis.confirmed_today_reservations, 1);
  assert.equal(filtered.data_quality.today_schedule_conflict_hours, 0);
  for (const overrides of [
    { blockedDates: ['2026-09-01'] },
    { courts: input.courts.map(value => ({ ...value, blocked: true })) },
  ]) {
    const snapshot = Insights.buildSnapshot({ ...input, ...overrides });
    assert.equal(snapshot.kpis.confirmed_today_hours, 3);
    assert.equal(snapshot.kpis.confirmed_today_reservations, 2);
    assert.equal(snapshot.data_quality.today_schedule_conflict_hours, 3);
  }
  for (const overrides of [
    { openingDate: '2026-09-02' },
    { courts: input.courts.map(value => ({ ...value, createdAt: '2026-09-01T16:00:00Z' })) },
    { courtId: 'unknown' },
  ]) {
    const snapshot = Insights.buildSnapshot({ ...input, ...overrides });
    assert.equal(snapshot.kpis.confirmed_today_hours, 0);
    assert.equal(snapshot.kpis.confirmed_today_reservations, 0);
  }
});

test('partly blocked fractional bookings count each occupied portion only once', () => {
  const row = booking({ ref: 'PARTIAL-A', groupRef: 'PARTIAL', date: '2026-09-01', slots: [], startTime: '8:00 AM', duration: 1.5 });
  const snapshot = Insights.buildSnapshot(baseInput({
    bookings: [row, { ...row }, booking({ ref: 'PARTIAL-B', groupRef: 'PARTIAL', date: '2026-09-01', slots: [], startTime: '9:00 AM', duration: 0.5 })],
    settings: {
      open_hour: '8', close_hour: '10',
      maintenance_config: { rules: [{ enabled: true, mode: 'specific', start: 9, end: 10, dates: ['2026-09-01'] }] },
    },
  }));
  assert.equal(snapshot.kpis.confirmed_today_hours, 1.5);
  assert.equal(snapshot.kpis.confirmed_today_reservations, 1);
  assert.equal(snapshot.data_quality.today_schedule_conflict_hours, 0.5);
});

test('six booked hours in five reservations stay visible when a later block overlaps one group hour', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-09T11:08:10Z',
    courts: [court(), court('court-2'), court('court-3'), court('court-4')],
    settings: {
      open_hour: '15', close_hour: '23',
      maintenance_config: { rules: [{ enabled: true, mode: 'specific', start: 22, end: 23, dates: ['2026-09-09'], courtIds: ['court-1', 'court-4'], label: 'blocked' }] },
    },
    bookings: [
      booking({ ref: 'A', courtId: 'court-3', date: '2026-09-09', slots: [22] }),
      booking({ ref: 'B', courtId: 'court-2', date: '2026-09-09', slots: [18] }),
      booking({ ref: 'C', date: '2026-09-09', slots: [17] }),
      booking({ ref: 'D', courtId: 'court-3', date: '2026-09-09', slots: [20] }),
      booking({ ref: 'GROUP-A', groupRef: 'GROUP', courtId: 'court-4', date: '2026-09-09', slots: [22] }),
      booking({ ref: 'GROUP-B', groupRef: 'GROUP', courtId: 'court-3', date: '2026-09-09', slots: [21] }),
      booking({ ref: 'FUTURE-A', courtId: 'court-3', date: '2026-09-10', slots: [21] }),
      booking({ ref: 'FUTURE-B', courtId: 'court-4', date: '2026-09-13', slots: [17, 18] }),
    ],
  }));
  assert.equal(snapshot.kpis.confirmed_today_hours, 6);
  assert.equal(snapshot.kpis.confirmed_today_reservations, 5);
  assert.equal(snapshot.data_quality.today_schedule_conflict_hours, 1);
  assert.equal(snapshot.kpis.booked_next_28_hours, 3);
  assert.equal(snapshot.period.learning_days, 0);
});

test('Philippine midnight moves yesterday out of today totals and into history', () => {
  const input = baseInput({
    bookings: [
      booking({ ref: 'FIRST-DAY', date: '2026-09-01', slots: [8] }),
      booking({ ref: 'NEXT-DAY', date: '2026-09-02', slots: [8, 9] }),
    ],
  });
  const before = Insights.buildSnapshot({ ...input, now: '2026-09-01T15:59:59Z' });
  assert.equal(before.period.today, '2026-09-01');
  assert.equal(before.kpis.confirmed_today_hours, 1);
  assert.equal(before.period.learning_days, 0);
  const after = Insights.buildSnapshot({ ...input, now: '2026-09-01T16:00:00Z' });
  assert.equal(after.period.today, '2026-09-02');
  assert.equal(after.kpis.confirmed_today_hours, 2);
  assert.equal(after.kpis.confirmed_today_reservations, 1);
  assert.equal(after.kpis.booked_next_28_hours, 0);
  assert.equal(after.period.learning_days, 1);
  assert.equal(after.data_quality.successful_reservations, 1);
  assert.equal(after.kpis.expected_total_fill_pct, null, 'one day still does not establish a forecast');
});

test('only paid successful reservations teach demand', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-05T12:00:00+08:00',
    bookings: [
      booking({ ref: 'GOOD', date: '2026-09-01' }),
      booking({ ref: 'UNPAID', date: '2026-09-02', paymentStatus: 'unpaid' }),
      booking({ ref: 'CANCELLED', date: '2026-09-03', status: 'cancelled' }),
      booking({ ref: 'PENDING', date: '2026-09-04', status: 'pending' }),
      booking({ ref: 'DOWNPAYMENT', date: '2026-09-04', slots: [9], paymentStatus: 'downpayment_paid' }),
    ],
  }));
  assert.equal(snapshot.data_quality.successful_booking_rows, 2);
  assert.equal(snapshot.data_quality.successful_reservations, 2);
  const learnedHours = snapshot.heatmap.reduce((sum, cell) => sum + cell.booked_hours, 0);
  assert.equal(learnedHours, 2);
});

test('Open Play, Maintenance, and blocked dates are removed from private-court demand capacity', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    bookings: [booking({ ref: 'PROGRAMMED', date: '2026-08-31', slots: [8, 9], duration: 2 })],
    settings: {
      open_hour: '8',
      close_hour: '10',
      open_play_config: JSON.stringify({ enabled: true, start: 8, end: 9, specificDates: ['2026-08-31'] }),
      maintenance_config: JSON.stringify({ rules: [{ enabled: true, mode: 'specific', start: 9, end: 10, dates: ['2026-08-31'] }] }),
    },
  }));
  assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.available_hours, 0), 0);
  assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.booked_hours, 0), 0);

  const blocked = Insights.buildSnapshot(baseInput({
    bookings: [booking({ ref: 'BLOCKED', date: '2026-08-31' })],
    blockedDates: ['2026-08-31'],
  }));
  assert.equal(blocked.signals.reduce((sum, signal) => sum + signal.booked_hours, 0), 0);
});

test('expected total fill combines existing future bookings with evidence-backed open-hour demand', () => {
  const history = [];
  for (let date = '2026-07-01'; date <= '2026-08-31'; date = addDays(date, 1)) {
    history.push(booking({ ref: `H-${date}`, date, slots: [8] }));
  }
  history.push(booking({ ref: 'FUTURE', date: '2026-09-02', slots: [8], status: 'pending', paymentStatus: 'unpaid' }));
  const snapshot = Insights.buildSnapshot(baseInput({
    settings: { open_hour: '8', close_hour: '9' },
    bookings: history,
  }));
  assert.ok(snapshot.period.learning_days >= 60);
  assert.equal(snapshot.kpis.booked_next_28_hours, 1);
  assert.equal(snapshot.kpis.expected_total_fill_pct, 100);
  assert.equal(snapshot.kpis.likely_open_hours, 0);
  assert.equal(snapshot.recommendation, null, 'a fully utilized schedule must not invent a quiet-hour action');
});

test('a zero-booking court learns from venue history without being stuck forever', () => {
  const courts = [court('court-1', 'Court 1'), court('court-2', 'Court 2')];
  const history = [];
  for (let date = '2026-07-01'; date <= '2026-08-31'; date = addDays(date, 1)) {
    history.push(booking({ ref: `V-${date}`, date, courtId: 'court-1' }));
  }
  const snapshot = Insights.buildSnapshot(baseInput({
    courts,
    bookings: history,
    courtId: 'court-2',
    settings: { open_hour: '8', close_hour: '9' },
  }));
  assert.ok(snapshot.period.learning_days >= 60);
  assert.ok(snapshot.signals.every(signal => signal.booked_hours === 0));
  assert.equal(snapshot.recommendation?.court_id, 'court-2');
  assert.equal(snapshot.recommendation?.action_type, 'feature_regular_price_hour');
});

test('receipt reviews reserve future capacity while only expired temporary holds are released', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-01T12:00:00+08:00',
    bookings: [
      booking({ ref: 'REAL-REVIEW', date: '2026-09-02', status: 'verifying', paymentStatus: 'for_verification', isTemporaryHold: false }),
      booking({ ref: 'FRESH-HOLD', date: '2026-09-03', status: 'verifying', isTemporaryHold: true, createdAt: '2026-09-01T11:50:01+08:00' }),
      booking({ ref: 'EXPIRED-HOLD', date: '2026-09-04', status: 'verifying', isTemporaryHold: true, createdAt: '2026-09-01T11:50:00+08:00' }),
      booking({ ref: 'UNKNOWN-TIME', date: '2026-09-05', status: 'verifying', isTemporaryHold: true, createdAt: null }),
      booking({ ref: 'FUTURE-TIME', date: '2026-09-06', status: 'verifying', isTemporaryHold: true, createdAt: '2026-09-01T12:01:00+08:00' }),
      booking({ ref: 'CANCELLED', date: '2026-09-07', status: 'cancelled' }),
      booking({ ref: 'FORFEITED', date: '2026-09-08', status: 'forfeited' }),
    ],
  }));
  assert.equal(snapshot.kpis.booked_next_28_hours, 4);
  assert.equal(snapshot.kpis.reserved_next_28_hours, 4, 'actual reservations use the same active status and expiry rules');
  assert.equal(snapshot.period.learning_days, 0, 'future holds and receipt reviews never teach historical demand');
});

test('blocking every court keeps actual grouped future reservations visible without sellable capacity', () => {
  const future = booking({ ref: 'GROUP-A', groupRef: 'GROUP', date: '2026-09-02', slots: [8, 9] });
  const input = baseInput({
    courts: [{ ...court(), blocked: true }, { ...court('court-2'), blocked: true }],
    bookings: [
      booking({ ref: 'HISTORY', date: '2026-07-01' }),
      future, { ...future },
      booking({ ref: 'GROUP-B', groupRef: 'GROUP', courtId: 'court-2', date: '2026-09-03', slots: [9] }),
    ],
  });
  const snapshot = Insights.buildSnapshot(input);
  assert.equal(snapshot.kpis.reserved_next_28_hours, 3);
  assert.equal(snapshot.data_quality.future_schedule_conflict_hours, 3);
  assert.equal(snapshot.kpis.booked_next_28_hours, 0, 'sellable-capacity counter retains its forecast meaning');
  assert.equal(snapshot.kpis.booked_next_28_pct, 0);
  assert.equal(snapshot.kpis.sellable_next_28_hours, 0);
  assert.equal(snapshot.kpis.expected_total_fill_pct, null);
  const filtered = Insights.buildSnapshot({ ...input, courtId: 'court-2' });
  assert.equal(filtered.kpis.reserved_next_28_hours, 1);
  assert.equal(filtered.data_quality.future_schedule_conflict_hours, 1);
});

test('future actual hours and availability conflicts deduplicate partial overlaps separately', () => {
  const partial = booking({ ref: 'PART-A', groupRef: 'PART', date: '2026-09-02', slots: [], startTime: '8:00 AM', duration: 1.5 });
  const snapshot = Insights.buildSnapshot(baseInput({
    bookings: [partial, { ...partial }, booking({ ref: 'PART-B', groupRef: 'PART', date: '2026-09-02', slots: [], startTime: '9:00 AM', duration: 0.5 })],
    settings: {
      open_hour: '8', close_hour: '10',
      maintenance_config: { rules: [{ enabled: true, mode: 'specific', start: 9, end: 10, dates: ['2026-09-02'] }] },
    },
  }));
  assert.equal(snapshot.kpis.reserved_next_28_hours, 1.5);
  assert.equal(snapshot.data_quality.future_schedule_conflict_hours, 0.5);
  assert.equal(snapshot.kpis.booked_next_28_hours, 1);
});

test('future reservations retain blocked dates and outside-hours bookings while rejecting invalid schedules', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    courts: [court(), { ...court('new-court'), createdAt: '2026-09-05T00:00:00+08:00' }],
    bookings: [
      booking({ ref: 'BLOCKED-DATE', date: '2026-09-02', slots: [8] }),
      booking({ ref: 'OUTSIDE-HOURS', date: '2026-09-03', slots: [7] }),
      booking({ ref: 'OPENPLAY', date: '2026-09-04', slots: [8] }),
      booking({ ref: 'PENDING', date: '2026-09-05', status: 'pending', paymentStatus: 'unpaid', slots: [9] }),
      booking({ ref: 'TODAY', date: '2026-09-01' }),
      booking({ ref: 'OUTSIDE-HORIZON', date: '2026-09-30' }),
      booking({ ref: 'INVALID-SLOTS', date: '2026-09-02', slots: [25] }),
      booking({ ref: 'UNKNOWN-COURT', date: '2026-09-03', courtId: 'unknown' }),
      booking({ ref: 'BEFORE-CREATION', date: '2026-09-03', courtId: 'new-court' }),
      booking({ ref: 'CANCELLED', date: '2026-09-06', status: 'cancelled' }),
      booking({ ref: 'FORFEITED', date: '2026-09-07', status: 'forfeited' }),
    ],
    blockedDates: ['2026-09-02'],
    settings: {
      open_hour: '8', close_hour: '10',
      open_play_config: { enabled: true, start: 8, end: 9, specificDates: ['2026-09-04'] },
    },
  }));
  assert.equal(snapshot.kpis.reserved_next_28_hours, 4);
  assert.equal(snapshot.data_quality.future_schedule_conflict_hours, 3);
  assert.equal(snapshot.kpis.booked_next_28_hours, 1);
  const invalidDate = Insights.buildSnapshot(baseInput({
    now: '2026-09-10T12:00:00+08:00',
    bookings: [booking({ date: '2026-09-31' })],
  }));
  assert.equal(invalidDate.kpis.reserved_next_28_hours, 0, 'calendar-invalid dates cannot become actual reservations');
  const preopening = Insights.buildSnapshot(baseInput({
    openingDate: '2026-09-05', bookings: [booking({ date: '2026-09-02' })],
  }));
  assert.equal(preopening.kpis.reserved_next_28_hours, 0);
});

test('excluded sessions cannot start learning or generate a quiet-hour recommendation', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    bookings: [
      booking({ ref: 'BLOCKED', date: '2026-07-01' }),
      booking({ ref: 'OPENPLAY', date: '2026-07-02' }),
      booking({ ref: 'MAINTENANCE', date: '2026-07-03' }),
      booking({ ref: 'OUTSIDE-HOURS', date: '2026-07-04', slots: [7] }),
    ],
    blockedDates: ['2026-07-01'],
    settings: {
      open_hour: '8', close_hour: '10',
      open_play_config: { enabled: true, start: 8, end: 9, specificDates: ['2026-07-02'] },
      maintenance_config: { rules: [{ enabled: true, mode: 'specific', start: 8, end: 9, dates: ['2026-07-03'] }] },
    },
  }));
  assert.equal(snapshot.period.from, null);
  assert.equal(snapshot.period.learning_days, 0);
  assert.equal(snapshot.data_quality.successful_booking_rows, 0);
  assert.equal(snapshot.data_quality.successful_reservations, 0);
  assert.equal(snapshot.kpis.expected_total_fill_pct, null);
  assert.equal(snapshot.recommendation, null);
});

test('midnight opening keeps all actual sellable hours and invalid schedules do not invent capacity', () => {
  const snapshot = Insights.buildSnapshot(baseInput({ settings: { open_hour: '0', close_hour: '2' } }));
  assert.equal(snapshot.kpis.sellable_next_28_hours, 56);
  assert.deepEqual([...new Set(snapshot.signals.map(signal => signal.start_hour))], [0, 1]);
  for (const settings of [{ open_hour: 'not-an-hour', close_hour: '22' }, { open_hour: '8', close_hour: '7' }]) {
    assert.throws(() => Insights.buildSnapshot(baseInput({ settings })), /opening and closing hours/);
  }
});

test('fully reserved evidence-qualified capacity reports zero remaining open hours', () => {
  const bookings = [booking({ date: '2026-07-01' })];
  for (let date = '2026-09-02'; date <= '2026-09-29'; date = addDays(date, 1)) {
    bookings.push(booking({ ref: `FULL-${date}`, date }));
  }
  const snapshot = Insights.buildSnapshot(baseInput({ settings: { open_hour: '8', close_hour: '9' }, bookings }));
  assert.equal(snapshot.kpis.booked_next_28_hours, 28);
  assert.equal(snapshot.kpis.forecast_coverage_pct, 100);
  assert.equal(snapshot.kpis.expected_total_fill_pct, 100);
  assert.equal(snapshot.kpis.likely_open_hours, 0);
});

test('invalid booked hours and missing starts never create demand at the opening hour', () => {
  const badRows = [
    { slots: [null] }, { slots: [''] }, { slots: [24] }, { slots: [8, 9.5] },
    { slots: [-1, 8] }, { slots: '8' }, { slots: [], startTime: 'not-time' },
    { slots: [], startTime: '' }, { slots: [], startTime: '25:00' },
    { slots: [], startTime: '8:00 PM trailing' }, { slots: [], startTime: '8:00', duration: -1 },
  ];
  for (const overrides of badRows) {
    const snapshot = Insights.buildSnapshot(baseInput({ bookings: [booking(overrides)] }));
    assert.equal(snapshot.period.learning_days, 0, JSON.stringify(overrides));
    assert.equal(snapshot.data_quality.successful_booking_rows, 0, JSON.stringify(overrides));
    const future = Insights.buildSnapshot(baseInput({ bookings: [booking({ ...overrides, date: '2026-09-02' })] }));
    assert.equal(future.kpis.booked_next_28_hours, 0, JSON.stringify(overrides));
  }
});

test('explicit slots remain authoritative, de-duplicated and separated across courts', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    courts: [court(), court('court-2', 'Court 2')],
    bookings: [
      booking({ ref: 'GROUP-A', groupRef: 'GROUP', slots: ['09', 8, '8'], duration: 9 }),
      booking({ ref: 'GROUP-B', groupRef: 'GROUP', courtId: 'court-2', slots: [9] }),
    ],
  }));
  assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.booked_hours, 0), 3);
  assert.equal(snapshot.data_quality.successful_reservations, 1);
  assert.equal(snapshot.data_quality.successful_booking_rows, 2);
});

test('valid legacy whole-hour starts are retained when explicit slots are absent', () => {
  for (const startTime of ['8:00 AM', '08:00:00', '8']) {
    const snapshot = Insights.buildSnapshot(baseInput({ bookings: [booking({ slots: [], startTime, duration: 2 })] }));
    assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.booked_hours, 0), 2);
  }
});

test('court creation uses Philippine dates consistently for history and future capacity', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-03T01:00:00+08:00',
    courts: [{ ...court(), createdAt: '2026-09-01T16:30:00Z' }],
    bookings: [
      booking({ ref: 'BEFORE-COURT', date: '2026-09-01' }),
      booking({ ref: 'ON-CREATION-DAY', date: '2026-09-02' }),
    ],
  }));
  assert.equal(snapshot.period.from, '2026-09-02');
  assert.equal(snapshot.data_quality.successful_booking_rows, 1);
  assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.available_hours, 0), 2);
  assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.booked_hours, 0), 1);
  const future = Insights.buildSnapshot(baseInput({ courts: [{ ...court(), createdAt: '2026-09-28T16:30:00Z' }] }));
  assert.equal(future.kpis.sellable_next_28_hours, 2, 'only Sep 29 exists within this forecast');
});

test('mobile demand map is compact, transposed, evidence-aware, and accessible', () => {
  const admin = read('admin.html');
  const styles = read('owner-insights.css');

  assert.match(admin, /id="prInsightMobileMap"/);
  assert.match(admin, /function renderPaddleInsightMobileMap\(\)/);
  assert.match(admin, /function renderPaddleInsightMobileUnavailable\(\)/);
  assert.match(admin, /Demand by weekday rows and time columns/);
  assert.match(admin, /role="rowheader"/);
  assert.match(admin, /role="columnheader"/);
  assert.match(admin, /aria-rowcount="8"/);
  assert.match(admin, /aria-colcount="\$\{starts\.length\+1\}"/);
  assert.match(admin, /Jump to time of day/);
  assert.match(admin, /\{id:'morning',label:'Morning'/);
  assert.match(admin, /\{id:'afternoon',label:'Afternoon'/);
  assert.match(admin, /\{id:'evening',label:'Evening'/);
  assert.match(admin, /Swipe times/);
  assert.doesNotMatch(admin, /id="prInsightDay"|prInsightMobileList|renderPaddleInsightMobileDay/);

  assert.match(admin, /const evidenceCells=cells\.filter/);
  assert.match(admin, /if\(!evidenceCells\.length\)/);
  assert.match(admin, /Learning your booking pattern/);
  assert.match(admin, /role="progressbar"/);
  assert.match(admin, /confidenceFor\(cell\)\.code==='learning'\?'—':`\$\{prInsightNumber\(cell\.utilization_pct\)\}%`/);
  assert.match(admin, /id="prInsightMobileDetail" role="region" aria-label="Selected hour details"/);
  assert.doesNotMatch(admin, /aria-describedby="prInsightMobileDetail"/);
  assert.match(admin, /onfocus="selectPaddleInsightMobileCell\(this\)"/);
  assert.match(admin, /function handlePaddleInsightMobileGridKey\(event\)/);
  const unavailable = admin.match(/function renderPaddleInsightUnavailable\(\)\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(unavailable, /_prInsightSnapshot=null;/);
  assert.match(unavailable, /renderPaddleInsightMobileUnavailable\(\);/);
  assert.match(admin, /requestAnimationFrame\(\(\)=>syncPaddleInsightMobilePeriod\(\)\)/);
  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].forEach(key => assert.match(admin, new RegExp(key)));

  assert.match(styles, /\.pr-insights-mobile-scroll \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/s);
  assert.match(styles, /\.pr-insights-mobile-scroll \{[^}]*touch-action: pan-x pan-y;/s);
  assert.match(styles, /\.pr-insights-mobile-day \{[^}]*position: sticky;[^}]*left: 0;/s);
  assert.match(styles, /\.pr-insights-mobile-grid-row \{[^}]*grid-template-columns: 56px repeat\(var\(--mobile-hour-count\), 56px\)/s);
  assert.match(styles, /\.pr-insights-mobile-cell \{[^}]*min-height: 44px;/s);
  assert.match(styles, /\.pr-insights-mobile-toolbar \{[^}]*display: grid;/s);
  assert.match(styles, /\.pr-insights-mobile-scroll-shell\.is-at-end::after \{ opacity: 0;/);
  assert.match(styles, /\.pr-insights-map-card \{ grid-row: 1; \}/);
  assert.match(styles, /\.pr-insights-action > \.pr-insights-empty \{ min-height: 0;/);
});

test('Paddle admin integration is branded, role-scoped, mobile-safe, and read-only', () => {
  const admin = read('admin.html');
  const config = read('supabase-config.js');
  const runtime = read('owner-insights.js');
  const styles = read('owner-insights.css');
  const headers = read('_headers');
  const worker = read('_worker.js');
  const deploy = read('deploy-cloudflare-pages.ps1');

  assert.match(admin, /data-s="insights" data-perm="insights"/);
  assert.match(admin, /CHINO Intelligence/);
  assert.match(admin, /Find quiet hours\. Fill more courts\./);
  assert.match(admin, /insights:'Insights'/);
  assert.match(admin, /insights:'insights'/);
  assert.match(admin, /renderPaddleInsights\(\{force:true\}\)/);
  assert.match(config, /owner:\s+\[[^\]]*'insights'/);
  assert.match(config, /court_owner:\s+\[[^\]]*'insights'/);
  assert.doesNotMatch(config.match(/staff:\s+\[[^\]]*\]/)?.[0] || '', /insights/);
  assert.match(config, /async getInsightBookings\(\)/);
  assert.match(config, /async getInsightInputs\(\)/);
  assert.match(config, /_pbReadInsightRows\('bookings',\s*'ref,booking_group_ref,court_id,date,slots,start_time,end_time,duration,status,payment_status,created_at,email,full_name'/);
  assert.match(config, /\.range\(from, from \+ pageSize - 1\)/);
  const bookingProjection = config.match(/function _pbInsightBooking\(row\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(bookingProjection, /isTemporaryHold:/);
  assert.doesNotMatch(bookingProjection, /(?:fullName|full_name|email|contact|receipt)\s*:/i, 'customer fields are used only to derive a hold flag, never projected');
  assert.match(admin, /await DB\.getInsightInputs\(\)/);
  assert.match(styles, /@media \(max-width: 680px\)/);
  assert.match(styles, /\.pr-insights-mobile-map \{ display: none/);
  assert.match(admin, /role="gridcell"/);
  assert.match(admin, /No price or booking is changed/);
  assert.doesNotMatch(`${runtime}\n${styles}`, /Korte|Bayabas|kortedoscdo\.club/i);
  assert.doesNotMatch(runtime, /discount|voucher|updateBooking|saveBooking/i);
  assert.match(headers, /\/owner-insights\.js[\s\S]*no-store/);
  assert.match(worker, /'\/owner-insights\.js'/);
  assert.match(deploy, /"owner-insights\.js"/);
  assert.match(deploy, /"owner-insights\.css"/);
});
