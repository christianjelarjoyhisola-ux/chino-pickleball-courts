const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');
const adapter = fs.readFileSync('supabase-config.js', 'utf8');
const edge = fs.readFileSync('supabase/functions/send-booking-status-email/index.ts', 'utf8');
const requestAuth = fs.readFileSync('supabase/functions/_shared/email-request.ts', 'utf8');
const emailTemplate = fs.readFileSync('supabase/functions/_shared/paddle-rage-email.ts', 'utf8');

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
