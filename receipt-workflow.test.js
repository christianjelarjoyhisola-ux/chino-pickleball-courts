const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const workflow = require('./receipt-workflow.js');
const pending = { status: 'pending', paymentStatus: 'for_verification', paymentMethod: 'maribank' };
test('receipt-free holds are awaiting payment, never owner review', () => {
  assert.equal(workflow.state(pending).code, 'awaiting_payment');
  assert.equal(workflow.state({ ...pending, receiptStatus: 'manual_review' }).code, 'awaiting_payment');
});
test('stored incomplete evidence and owner review are separate', () => {
  const row = { ...pending, receiptImageUrl: 'private/path', receiptStatus: 'manual_review' };
  assert.equal(workflow.state(row).code, 'manual_review');
  assert.equal(workflow.state({ ...row, receiptFlags: ['REF_UNREADABLE'] }).code, 'receipt_correction');
  for (const paymentStatus of ['paid', 'downpayment_paid', 'rejected']) assert.equal(workflow.state({ ...row, paymentStatus }), null);
  for (const status of ['cancelled', 'completed', 'forfeited']) assert.equal(workflow.state({ ...row, status }), null);
});
test('image load failure obtains a fresh URL and retries; stale loads stay hidden', async () => {
  let attempts = 0;
  global.Image = class { set src(url) { queueMicrotask(() => url === 'bad' ? this.onerror() : this.onload()); } };
  const image = { removeAttribute() {} }, link = { style: {} }, message = { style: {} };
  await workflow.showImage({ image, link, message, getUrl: async () => ++attempts === 1 ? 'bad' : 'fresh', isCurrent: () => true });
  assert.equal(attempts, 2); assert.equal(image.src, 'fresh'); assert.equal(link.href, 'fresh'); assert.equal(message.style.display, 'none');
  await workflow.showImage({ image, link, message, getUrl: async () => 'old', isCurrent: () => false });
  assert.equal(link.style.display, 'none');
  delete global.Image;
});
test('checkout clock is 15 minutes and protects upload and durable evidence', () => {
  const page = fs.readFileSync('index.html','utf8');
  assert.match(page, /const RESERVATION_MINUTES = 15/);
  const tick = page.slice(page.indexOf('if (secsLeft <= 0)'), page.indexOf('function stopSlotCountdown'));
  assert.ok(tick.indexOf('_bookingSubmissionInFlight') < tick.indexOf('closeBookModal'));
  assert.ok(tick.indexOf('stagedReceiptPath') < tick.indexOf('closeBookModal'));
});
