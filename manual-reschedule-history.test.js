const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const admin = fs.readFileSync('admin.html', 'utf8');
const dataSource = fs.readFileSync('supabase-config.js', 'utf8');

function uiHarness(role = 'owner') {
  const start = admin.indexOf('let _manualRescheduleRows = [];');
  const end = admin.indexOf('async function loadManualRescheduleHistory', start);
  const context = vm.createContext({
    sess: { role },
    fmtD: value => value,
    fmtHour: value => `${value}:00`,
    jsArg: value => String(value).replaceAll("'", "\\'"),
    Intl,
    Date,
    Set,
    Map,
  });
  vm.runInContext(`${admin.slice(start, end)}\nthis.setRows = rows => { _manualRescheduleRows = rows; };`, context);
  return context;
}

test('manual reschedule history is a dedicated owner view with useful filters', () => {
  assert.match(admin, /id="manualRescheduleHistoryBtn"[\s\S]*?>[\s\S]*?Manual Reschedules/);
  assert.match(admin, /id="manualRescheduleHistoryModal"/);
  assert.match(admin, /id="mrhSearch"/);
  assert.match(admin, /id="mrhDate"/);
  assert.match(admin, /id="mrhActor"/);
  assert.match(admin, /Original[\s\S]*Moved to/);
  assert.match(admin, /openBookingFromManualReschedule/);
  assert.match(admin, /booking-manual-reschedule-note/);
});

test('manual reschedule helpers identify affected groups and format both schedules safely', () => {
  const context = uiHarness();
  context.setRows([{ bookingRef: 'PB-2' }]);
  assert.match(context.manualRescheduleBadge({ ref:'PB-1', primaryRef:'PB-1', items:[{ref:'PB-2'}] }), /Manually rescheduled/);
  assert.equal(context.manualRescheduleBadge({ ref:'PB-3' }), '');
  assert.equal(context.manualRescheduleScheduleLabel({ date:'2026-09-14', slots:['18','19'] }), '2026-09-14 · 18:00 – 20:00');
  assert.equal(context.manualRescheduleChangedDate('2026-09-13T17:30:00Z'), '2026-09-14');
  assert.equal(context.manualRescheduleActorLabel({ actorName:'Maria', actorRole:'court_owner' }), 'Maria · court owner');
});

test('manual reschedule audit data joins bookings and operator accounts without changing booking status', () => {
  const start = dataSource.indexOf('  async listAdminRescheduleHistory(');
  const end = dataSource.indexOf('  async getBookingRescheduleOptions(', start);
  const method = dataSource.slice(start, end);
  assert.match(method, /admin_booking_reschedule_history/);
  assert.match(method, /actor_id/);
  assert.match(method, /from\('bookings'\)/);
  assert.match(method, /from\('accounts'\)/);
  assert.match(method, /customerName/);
  assert.match(method, /actorName/);
  assert.doesNotMatch(method, /status\s*:/);
  assert.equal(uiHarness('owner').canViewManualRescheduleHistory(), true);
  assert.equal(uiHarness('court_owner').canViewManualRescheduleHistory(), true);
  assert.equal(uiHarness('staff').canViewManualRescheduleHistory(), false);
});
