const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');

test('dashboard provides an accessible manual-confirmation notice', () => {
  assert.match(admin, /id="dashboardPendingNotice"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(admin, /id="dashboardPendingTitle">Pending bookings need manual confirmation/);
  assert.match(admin, /Review pending bookings/);
});

test('dashboard counts only grouped bookings that are ready for manual confirmation', () => {
  assert.match(admin, /function dashboardPendingConfirmations\(transactions = \[\]\)[\s\S]*?filter\(booking => !bookingQuickConfirmIssue\(booking\)\)/);
  assert.match(admin, /const activeTxns=groupBookings\(active\);[\s\S]*?renderDashboardPendingNotice\(activeTxns\)/);
  assert.match(admin, /notice\.hidden = count === 0/);
});

test('dashboard notice opens the booking list with Pending selected', () => {
  assert.match(admin, /async function openDashboardPendingBookings\(\)[\s\S]*?await goto\('bookings'\)[\s\S]*?setBookingStatusView\('pending'\)/);
  assert.match(admin, /bookingQuickNav[\s\S]*?scrollIntoView/);
});
