const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Insights = require('./owner-insights.js');

const admin = fs.readFileSync(`${__dirname}/admin.html`, 'utf8');
const source = admin.slice(admin.indexOf('let _prInsightSnapshot=null;'), admin.indexOf('let _courtActivityBookings = null;'));

function element() {
  return { textContent: '', innerHTML: '', dataset: {}, value: '', disabled: false,
    attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelector() { return null; } };
}
function harness(db = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const buttons = [];
  const context = vm.createContext({
    window: { PaddleRageInsights: Insights }, DB: db, $: get,
    document: { querySelectorAll: () => buttons },
    console: { error() {} }, toast() {},
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  vm.runInContext(source, context);
  return { context, get, buttons, run: code => vm.runInContext(code, context) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('failed Insights refresh clears previous numbers, notes and actionable recommendation', async () => {
  const h = harness({ getInsightInputs: async () => { throw new Error('blocked dates unavailable'); } });
  for (const id of ['prInsightTodayNote', 'prInsightBookedNote', 'prInsightExpectedNote', 'prInsightActionNote']) h.get(id).textContent = 'Old 90% result';
  h.run('_prInsightSnapshot={recommendation:{id:"old-action"}}');
  await h.run('renderPaddleInsights({force:true})');
  assert.equal(h.get('prInsightBooked').textContent, '—');
  assert.equal(h.get('prInsightToday').textContent, '—');
  assert.equal(h.get('prInsightActionCount').textContent, 'Paused');
  assert.equal(h.get('prInsights').attributes['aria-busy'], 'false');
  assert.equal(h.get('prInsightRefresh').disabled, false);
  assert.equal(h.run('_prInsightSnapshot'), null);
  for (const id of ['prInsightTodayNote', 'prInsightBookedNote', 'prInsightExpectedNote', 'prInsightActionNote']) assert.doesNotMatch(h.get(id).textContent, /90%/);
  assert.match(h.get('prInsightAction').innerHTML, /Recommendations paused/);
  assert.doesNotMatch(h.get('prInsightAction').innerHTML, /Collecting reliable history|Copy CHINO/);
});

test('missing strict loader never falls back to incomplete general booking reads', async () => {
  let generalReads = 0;
  const h = harness({ getBookings() { generalReads++; return []; } });
  await h.run('renderPaddleInsights()');
  assert.equal(generalReads, 0);
  assert.equal(h.get('prInsightActionCount').textContent, 'Paused');
});

test('first-day bookings remain visible while forecasts clearly explain their learning period', () => {
  const h = harness();
  h.run('renderPaddleInsightHeatmap=()=>{}; renderPaddleInsightAction=()=>{};');
  h.context.snapshot = {
    period: { today: '2026-09-09', from: null, to: '2026-09-08', learning_days: 0,
      minimum_learning_days: 30, forecast_from: '2026-09-10', forecast_to: '2026-10-07' },
    kpis: { confirmed_today_hours: 6, confirmed_today_reservations: 5, booked_next_28_hours: 3,
      sellable_next_28_hours: 800, booked_next_28_pct: 0.375, expected_total_fill_pct: null },
    data_quality: { today_schedule_conflict_hours: 1 },
  };
  h.run('renderPaddleInsightSnapshot(snapshot,"All courts")');
  assert.equal(h.get('prInsightToday').textContent, '6 hr');
  assert.match(h.get('prInsightTodayNote').textContent, /5 confirmed reservations/);
  assert.match(h.get('prInsightTodayNote').textContent, /1 hr outside current availability/);
  assert.equal(h.get('prInsightBooked').textContent, '3 hr');
  assert.equal(h.get('prInsightExpected').textContent, 'Learning');
  assert.match(h.get('prInsightExpectedNote').textContent, /0 of 30 history days.*midnight PH/);
  assert.match(h.get('prInsightStatus').innerHTML, /join history after midnight PH/);
  assert.match(h.get('prInsightMapSummary').textContent, /6 confirmed court-hours today/);
  assert.doesNotMatch(h.get('prInsightExpectedNote').textContent, /Begins after the first/);
});

test('upcoming-only bookings show reservations without inventing a forecast or today bookings', () => {
  const h = harness();
  h.run('renderPaddleInsightHeatmap=()=>{}; renderPaddleInsightAction=()=>{};');
  h.context.snapshot = {
    period: { today: '2026-09-09', from: null, learning_days: 0, forecast_from: '2026-09-10', forecast_to: '2026-10-07' },
    kpis: { confirmed_today_hours: 0, confirmed_today_reservations: 0, booked_next_28_hours: 2, expected_total_fill_pct: null },
  };
  h.run('renderPaddleInsightSnapshot(snapshot,"Court 1")');
  assert.equal(h.get('prInsightToday').textContent, '0 hr');
  assert.equal(h.get('prInsightBooked').textContent, '2 hr');
  assert.equal(h.get('prInsightExpected').textContent, 'Learning');
  assert.match(h.get('prInsightExpectedNote').textContent, /0 of 30 history days/);
  assert.doesNotMatch(h.get('prInsightExpectedNote').textContent, /today’s sessions join/);
});

test('initial mobile map and Court Pick explain their distinct evidence requirements', () => {
  const h = harness();
  h.context.snapshot = {
    period: { today: '2026-09-09', from: null, learning_days: 0, minimum_learning_days: 30,
      minimum_recommendation_comparable_days: 8 },
    heatmap: [{ weekday: 1, start_hour: 17, comparable_days: 0, available_hours: 0 }],
  };
  h.run('_prInsightSnapshot=snapshot; renderPaddleInsightMobileMap(); renderPaddleInsightAction(snapshot);');
  assert.match(h.get('prInsightMobileMap').innerHTML, /0 \/ 4/);
  assert.match(h.get('prInsightMobileMap').innerHTML, /aria-valuemax="4"/);
  assert.match(h.get('prInsightMobileMap').innerHTML, /after midnight PH/);
  assert.match(h.get('prInsightAction').innerHTML, /30 past calendar days and 8 comparable/);
});

test('blocked courts retain actual reservations and explain unavailable forecasts instead of implying no bookings', () => {
  const h = harness();
  h.run('renderPaddleInsightHeatmap=()=>{};');
  h.context.snapshot = {
    period: { today: '2026-09-09', from: null, learning_days: 0, forecast_from: '2026-09-10', forecast_to: '2026-10-07' },
    kpis: { confirmed_today_hours: 6, confirmed_today_reservations: 5, reserved_next_28_hours: 3,
      booked_next_28_hours: 0, sellable_next_28_hours: 0, expected_total_fill_pct: null },
    data_quality: { today_schedule_conflict_hours: 6, future_schedule_conflict_hours: 3 },
  };
  h.run('renderPaddleInsightSnapshot(snapshot,"All courts")');
  assert.equal(h.get('prInsightToday').textContent, '6 hr');
  assert.equal(h.get('prInsightBooked').textContent, '3 hr');
  assert.match(h.get('prInsightBookedNote').textContent, /No available court-hours.*3 booked hr retained/);
  assert.equal(h.get('prInsightExpected').textContent, 'Unavailable');
  assert.match(h.get('prInsightExpectedNote').textContent, /No available hours/);
  assert.equal(h.get('prInsightActionCount').textContent, 'Paused');
  assert.match(h.get('prInsightAction').innerHTML, /Existing reservations remain recorded/);
  assert.doesNotMatch(h.get('prInsightAction').innerHTML, /Copy CHINO|first qualifying/);
});

test('overlapping refreshes render only the newest complete input set', async () => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const h = harness({ getInsightInputs: () => (++reads === 1 ? first.promise : second.promise) });
  h.run(`ensurePaddleInsightCourts=async()=>[];
    window.PaddleRageInsights={buildSnapshot: input=>input};
    renderPaddleInsightSnapshot=snapshot=>{window.lastSnapshot=snapshot};`);
  const oldRefresh = h.run('renderPaddleInsights()');
  const newRefresh = h.run('renderPaddleInsights()');
  second.resolve({ bookings: ['new'], courts: [], settings: {}, blockedDates: [] });
  await newRefresh;
  first.resolve({ bookings: ['old'], courts: [], settings: {}, blockedDates: [] });
  await oldRefresh;
  assert.equal(h.run('window.lastSnapshot.bookings[0]'), 'new');
  assert.equal(h.get('prInsightRefresh').disabled, false);
});

test('a refresh suspends copying an old Court Pick while fresh data is loading', async () => {
  const data = deferred();
  const h = harness({ getInsightInputs: () => data.promise });
  const copy = element();
  h.get('prInsightAction').querySelector = () => copy;
  h.run('_prInsightSnapshot={recommendation:{id:"old"}}');
  const pending = h.run('renderPaddleInsights()');
  assert.equal(h.run('_prInsightSnapshot'), null);
  assert.equal(copy.disabled, true);
  data.reject(new Error('test load failure'));
  await pending;
});

test('selecting a desktop demand cell exposes the matching evidence', () => {
  const h = harness();
  const selected = element(), other = element();
  selected.dataset = { weekday: '1', hour: '18' };
  h.buttons.push(selected, other);
  h.context.selected = selected;
  h.run(`_prInsightSnapshot={heatmap:[{weekday:1,weekday_label:'Mon',start_hour:18,end_hour:19,comparable_days:8,available_hours:8,booked_hours:2,utilization_pct:25}]};
    selectPaddleInsightDesktopCell(selected);`);
  assert.match(h.get('prInsightDesktopDetail').innerHTML, /Monday.*6 PM–7 PM/);
  assert.match(h.get('prInsightDesktopDetail').innerHTML, /2\.0 of 8\.0 sellable court-hours booked/);
  assert.equal(selected.attributes['aria-selected'], 'true');
  assert.equal(other.attributes['aria-selected'], 'false');
});

test('fully booked evidence renders zero open hours, and partial estimates disclose their scope', () => {
  const h = harness();
  h.run('renderPaddleInsightHeatmap=()=>{}; renderPaddleInsightAction=()=>{};');
  h.context.snapshot = {
    period: { from: '2026-07-01', to: '2026-09-08', learning_days: 70, forecast_from: '2026-09-10', forecast_to: '2026-10-07' },
    kpis: { expected_total_fill_pct: 100, likely_open_hours: 0, forecast_coverage_pct: 50 },
  };
  h.run('renderPaddleInsightSnapshot(snapshot,"All courts")');
  assert.match(h.get('prInsightMapSummary').textContent, /About 0/);
  assert.doesNotMatch(h.get('prInsightMapSummary').textContent, /Still learning/);
  assert.match(h.get('prInsightExpectedNote').textContent, /50% of upcoming hours with comparable evidence/);
  assert.match(h.get('prInsightStatus').innerHTML, /Updated .* PH/);
  h.context.snapshot.kpis.expected_total_fill_pct = null;
  h.context.snapshot.kpis.likely_open_hours = null;
  h.run('renderPaddleInsightSnapshot(snapshot,"All courts")');
  assert.match(h.get('prInsightExpectedNote').textContent, /Waiting for comparable court-hour history/);
});

test('an Insights realtime update is deferred rather than discarded while its court filter has focus', async () => {
  let scheduled = 0;
  const context = vm.createContext({
    document: { hidden: false, activeElement: { tagName: 'SELECT' }, querySelector: () => null },
    _curSection: 'insights', clearTimeout() {}, setTimeout() { scheduled++; return scheduled; },
  });
  const realtime = admin.slice(admin.indexOf('let _admRtDebounce=null;'), admin.indexOf('function startAdminRealtime(){'));
  vm.runInContext(realtime, context);
  await vm.runInContext('_admRtRefreshQueued=true; flushAdminRealtimeRefresh()', context);
  assert.equal(vm.runInContext('_admRtRefreshQueued', context), true);
  assert.equal(scheduled, 1);
});
