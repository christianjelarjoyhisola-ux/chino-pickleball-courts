const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = file => fs.readFileSync(file, 'utf8');
const admin = read('admin.html');
const config = read('supabase-config.js');
const migration = read('supabase/migrations/20260911113000_booking_cancellation_records.sql');

test('manual booking cancellation is atomic, grouped, authorized, and permanently recorded', () => {
  assert.match(migration, /create table public\.booking_cancellation_records/);
  assert.match(migration, /booking_refs text\[\] not null/);
  assert.match(migration, /reason_code text not null/);
  assert.match(migration, /cancelled_by_user_id uuid not null/);
  assert.match(migration, /cancelled_by_name text not null/);
  assert.match(migration, /cancelled_by_role text not null/);
  assert.match(migration, /cancelled_at timestamptz not null/);
  assert.match(migration, /public\.has_account_role\(array\['owner','court_owner'\]\)/);
  assert.match(migration, /pg_advisory_xact_lock_shared[\s\S]*?for update/);
  assert.match(migration, /update public\.bookings b set status='cancelled' where b\.ref=any\(actual_refs\)/);
  assert.match(migration, /insert into public\.booking_cancellation_records/);
  assert.match(migration, /booking_cancellation_records_no_update_delete/);
  assert.match(migration, /Completed or forfeited bookings cannot be cancelled here/);
  assert.match(migration, /payment_reassigned_to_ref is not null/);
  assert.match(migration, /reason_key = 'other'.*char_length/s);
});

test('admin cancellation form requires a category and protects the internal note', () => {
  for (const value of ['player_request','duplicate_mistake','payment_not_received','court_unavailable','weather','incomplete_hold','other']) {
    assert.match(admin, new RegExp(`<option value="${value}">`));
  }
  assert.match(admin, /id="bookingCancelReason" required/);
  assert.match(admin, /reasonCode==='other'&&note\.length<5/);
  assert.match(admin, /The private note is not sent to the player/);
  assert.match(admin, /DB\.cancelBookingGroup\(canonicalRef,reasonCode,note\)/);
  assert.match(admin, /sendBookingStatusEmail\(canonicalRef,'booking_cancelled',bookingCancellationCustomerMessage\(reasonCode\)/);
  assert.doesNotMatch(admin, /sendBookingStatusEmail\(canonicalRef,'booking_cancelled',note/);
  assert.match(admin, /if \(status === 'cancelled'\) \{[\s\S]*?openBookingCancelModal\(ref, document\.activeElement\)/);
});

test('cancellation records load in Booking Details and local preview mirrors production', () => {
  assert.match(admin, /function renderBookingCancellationHistory/);
  assert.match(admin, /<h3>Cancellation record<\/h3>/);
  assert.match(admin, /Internal note:/);
  assert.match(admin, /PH time/);
  assert.equal((config.match(/async cancelBookingGroup\(ref, reasonCode, note = ''\)/g) || []).length, 2);
  assert.match(config, /\.rpc\('cancel_booking_group'/);
  assert.equal((config.match(/async getBookingCancellationHistory\(refs\)/g) || []).length, 2);
  assert.match(config, /\.from\('booking_cancellation_records'\)[\s\S]*?\.overlaps\('booking_refs', bookingRefs\)/);
  assert.match(config, /bookingCancellationRecords: \[\]/);
});
