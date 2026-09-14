const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');

test('quick Confirm opens the receipt review instead of deciding immediately', () => {
  assert.match(admin, /function quickConfirmBooking\(ref, trigger\)[\s\S]*?openVerifyModal\(ref, \{ returnFocus: trigger \}\)/);
  assert.doesNotMatch(admin, /function quickConfirmBooking\(ref, trigger\)[\s\S]*?confirmBookingTransaction\(ref, \{ trigger \}\)/);
});

test('confirm review places the receipt left and booking details right', () => {
  const modal = admin.match(/<!-- VERIFY PAYMENT MODAL -->[\s\S]*?<!-- BOOKING PAYMENT REJECTION REASON -->/)?.[0] || '';
  assert.match(modal, /payment-review-layout[\s\S]*?payment-review-receipt-pane[\s\S]*?vmReceiptImg[\s\S]*?payment-review-details-pane/);
  assert.match(modal, /payment-review-details-pane[\s\S]*?vmName[\s\S]*?vmCourt[\s\S]*?vmDate[\s\S]*?vmAmount/);
  assert.match(admin, /\.payment-review-layout\s*\{[^}]*grid-template-columns/);
});

test('reject review also places the receipt left and complete details right', () => {
  const modal = admin.match(/<!-- BOOKING PAYMENT REJECTION REASON -->[\s\S]*?<!-- CANCELLED-BOOKING PAYMENT REASSIGNMENT -->/)?.[0] || '';
  assert.match(modal, /booking-payment-reject-layout[\s\S]*?bookingPaymentRejectReceiptImg[\s\S]*?booking-payment-reject-details/);
  assert.match(modal, /bookingPaymentRejectName[\s\S]*?bookingPaymentRejectCourt[\s\S]*?bookingPaymentRejectSchedule[\s\S]*?bookingPaymentRejectMethod[\s\S]*?bookingPaymentRejectPaymentRef/);
  assert.match(admin, /populateBookingPaymentRejectReceipt\(booking\)/);
  assert.match(admin, /@media \(max-width: 760px\)[\s\S]*?payment-review-layout,[\s\S]*?booking-payment-reject-layout\s*\{\s*grid-template-columns:1fr/);
});
