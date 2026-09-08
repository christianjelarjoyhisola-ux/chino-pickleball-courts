const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const admin = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const adminStart = admin.lastIndexOf('async function saveNewBooking()');
const saveSource = admin.slice(adminStart, admin.indexOf('async function calOpenBookingSlot(', adminStart));
const addSource = client.slice(client.indexOf('  async addBookings(bookings)'), client.indexOf('  async releaseBookingHold('));
const adapterSource = client.slice(client.indexOf('function bookingToRow('), client.indexOf('function withoutOptionalBookingColumns('));

function harness({ conflict = false } = {}) {
  const state = { rows: [], insertCalls: [], notices: [], closed: false };
  const inputs = {
    nbName: { value: 'Test Player' }, nbPhone: { value: '09171234567' }, nbEmail: { value: '' },
    nbDate: { value: '2026-10-01' }, nbMethod: { value: 'cash' }, nbGcashRef: { value: '' },
    nbStatus: { value: 'confirmed' }, nbSaveBtn: { disabled: false, textContent: '+ Create Booking' },
  };
  const groups = ['first', 'second'].map(id => ({
    court: { id, name: `Court ${id}`, rate: 300 }, slots: [9], slotRates: [300],
    startH: 9, endH: 10, duration: 1, total: 300, courtFee: 300, bookingFee: 0,
  }));
  const context = vm.createContext({
    console: { error() {} }, $: id => inputs[id], _curSection: 'bookings',
    nbGroupsWithFees: () => groups, nbGenRef: () => 'ATOMIC', fmtHour: value => `${value}:00`,
    currentBookingActorFields: () => ({ createdVia: 'admin', createdByRole: 'owner' }),
    toast: (message, severity) => state.notices.push({ message, severity }),
    closeModal: () => { state.closed = true; },
    nbAggregateBooking: () => ({}), renderBookings: async () => {}, renderDash: async () => {},
    notifyBookingUpdateSafe: () => {}, sendBookingConfirmationNotice: () => { assert.fail('Fixture must not send emails'); },
    _pbHasActiveAccount: async () => true, _pbAssertPublicBookingDate: () => {},
    _pbClearFastCache: () => {}, receivedAccountForBooking: () => 'court_owner',
    hasSlotConflict: () => false, isMissingOptionalBookingColumnError: () => false,
    _sb: { from(table) {
      assert.equal(table, 'bookings');
      return { async insert(rows) {
        state.insertCalls.push(plain(rows));
        // Model a database conflict that appeared after the availability read:
        // the statement rejects atomically if its second court is occupied.
        if (conflict && rows.some(row => row.court_id === 'second')) {
          return { error: new Error('The second court is no longer available.') };
        }
        state.rows.push(...plain(rows));
        return { error: null };
      } };
    } },
  });
  vm.runInContext(`${adapterSource}\nthis.DB = { ${addSource} };\n${saveSource}`, context);
  context.DB.getBookings = async () => [];
  return { context, state, inputs };
}

test('manual multi-court booking commits all paid rows in one atomic database statement', async () => {
  const { context, state, inputs } = harness();
  await context.saveNewBooking();
  assert.equal(state.insertCalls.length, 1);
  assert.equal(state.insertCalls[0].length, 2);
  assert.deepEqual(state.rows.map(row => row.payment_status), ['paid', 'paid']);
  assert.deepEqual(state.rows.map(row => row.status), ['confirmed', 'confirmed']);
  assert.deepEqual(state.rows.map(row => row.booking_group_ref), ['ATOMIC-G', 'ATOMIC-G']);
  assert.equal(state.closed, true);
  assert.equal(inputs.nbSaveBtn.disabled, false);
});

test('a later-court conflict leaves no earlier confirmed or paid manual booking behind', async () => {
  const { context, state, inputs } = harness({ conflict: true });
  await context.saveNewBooking();
  assert.equal(state.insertCalls.length, 1, 'selected courts must share one write');
  assert.equal(state.insertCalls[0].length, 2);
  assert.deepEqual(state.rows, []);
  assert.equal(state.closed, false);
  assert.equal(inputs.nbSaveBtn.disabled, false);
  assert.ok(state.notices.some(notice => notice.severity === 'err' && /no longer available/.test(notice.message)));
  assert.equal(state.notices.some(notice => /Booking created/.test(notice.message)), false);
});
