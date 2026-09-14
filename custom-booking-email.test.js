const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');
const adapter = fs.readFileSync('supabase-config.js', 'utf8');
const edge = fs.readFileSync('supabase/functions/send-booking-status-email/index.ts', 'utf8');
const requestAuth = fs.readFileSync('supabase/functions/_shared/email-request.ts', 'utf8');
const emailTemplate = fs.readFileSync('supabase/functions/_shared/paddle-rage-email.ts', 'utf8');
const paymentReviewMigration = fs.readFileSync('supabase/migrations/20260901090000_receipt_review_maribank.sql', 'utf8');
const securityBankMigration = fs.readFileSync('supabase/migrations/20260909103000_security_bank_payment_method.sql', 'utf8');

test('custom booking email is exposed only to system and court owners', () => {
  assert.match(admin, /function canSendCustomBookingEmail\(\)[\s\S]*?\['owner','court_owner'\]/);
  assert.match(admin, /bookingCustomEmailButton\(b/);
  assert.match(admin, /Only the System Owner or Court Owner can email booking customers/);
  assert.match(edge, /customMessage[\s\S]*?requireOwnerEmailRequest\(req, db\)/);
  assert.match(requestAuth, /\["owner", "court_owner"\]\.includes/);
});

test('custom booking email uses the canonical booking recipient and bounded content', () => {
  assert.match(edge, /const email = String\(first\.email/);
  assert.doesNotMatch(admin, /id="customBookingEmailRecipient"[^>]*contenteditable/);
  assert.match(admin, /id="customBookingEmailSubject"[^>]*maxlength="120"/);
  assert.match(admin, /id="customBookingEmailMessage"[^>]*maxlength="4000"/);
  assert.match(edge, /customSubject\.length < 3 \|\| customSubject\.length > 120/);
  assert.match(edge, /customBody\.length < 10 \|\| customBody\.length > 4000/);
});

test('custom booking email is branded, escaped, and audited', () => {
  assert.match(adapter, /event: 'custom_message'/);
  assert.match(edge, /setAdminActivityContext\(req, \{ action: event, targetType: "booking", targetId: bookingRef \}\)/);
  assert.match(edge, /renderCustomBookingMessageEmail/);
  assert.match(emailTemplate, /message\.split\("\\n"\)\.map/);
  assert.match(emailTemplate, /line \? escapeHtml\(line\) : "&nbsp;"/);
  assert.match(emailTemplate, /MESSAGE ABOUT YOUR BOOKING/);
});

test('regular digital bookings awaiting review show a quick Reject Payment action', () => {
  assert.match(admin, /function bookingQuickRejectButton\(b, mobile = false\)/);
  assert.match(admin, /if \(b\?\.hostBooking \|\| !bookingPaymentCanBeRejected\(b\)\) return ''/);
  assert.match(admin, /bookingQuickConfirmButton\(b\)\}\$\{bookingQuickRejectButton\(b\)/);
  assert.match(admin, /bookingQuickConfirmButton\(b, true\)\}\$\{bookingQuickRejectButton\(b, true\)/);
  assert.match(admin, /booking-quick-reject[\s\S]*?openBookingPaymentRejectModal/);
});

test('quick rejection reuses the reason, email, and atomic group safeguards', () => {
  assert.match(admin, /id="bookingPaymentRejectReason"[^>]*required[^>]*minlength="3"/);
  assert.match(admin, /DB\.rejectBookingPaymentTransaction\(canonicalRef, reason\)/);
  assert.match(admin, /DB\.sendBookingStatusEmail\(canonicalRef, 'payment_rejected'/);
  assert.match(adapter, /rpc\('reject_booking_payment_transaction'/);
  assert.match(paymentReviewMigration, /has_account_role\(array\['owner', 'court_owner'\]\)/);
  assert.match(paymentReviewMigration, /update public\.bookings b[\s\S]*?status = 'cancelled'[\s\S]*?payment_status = 'rejected'/);
  assert.match(paymentReviewMigration, /updated_count <> cardinality\(actual_refs\)/);
  assert.match(securityBankMigration, /public\.reject_booking_payment_transaction\(text,text\)/);
});

test('resolved, cash, host-balance, and terminal bookings remain ineligible for quick rejection', () => {
  assert.match(admin, /if \(b\.hostBooking && hostBalancePendingPayment\(b\)\) return false/);
  assert.match(admin, /methods\.length !== 1 \|\| !isDigitalPayment\(methods\[0\]\)/);
  assert.match(admin, /rows\.every\(row => \['pending','verifying'\]\.includes/);
  assert.match(admin, /rows\.every\(row => \['unpaid','pending','for_verification'\]\.includes/);
});
