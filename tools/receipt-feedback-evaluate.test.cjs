'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLabels, evaluateLabels } = require('./receipt-feedback-evaluate.cjs');
const hash = i => i.toString(16).padStart(64, '0');
const label = (i, changes = {}) => ({ receiptImageHash: hash(i), bookingRef: `TEST-${i}`, evidenceSource: 'receiving_account_reconciliation', evidenceReference: `offline-statement-${i}`, paymentOutcome: 'received', receiptMatchesBooking: true, reviewedAt: '2026-09-10T02:00:00Z', ...changes });
const document = labels => ({ version: 'receipt_reconciliation_labels_v1', labels });
const event = (i, outcome, changes = {}) => ({ id: String(i), receipt_image_hash: hash(i), booking_ref: `TEST-${i}`, event_type: 'analysis', outcome, created_at: '2026-09-10T01:00:00Z', ...changes });

test('independent labels measure only matching analyses, with explicit denominators', () => {
  const labels = validateLabels(document([label(1, { paymentOutcome: 'not_received' }), label(2), label(3), label(4)]));
  const result = evaluateLabels(labels, [event(1, 'auto_valid'), event(2, 'pending'), event(3, 'auto_valid')]);
  assert.equal(result.matchedLabels, 3);
  assert.equal(result.unmatchedLabels, 1);
  assert.equal(result.falseApprovals, 1);
  assert.equal(result.falseApprovalRate, .5);
  assert.equal(result.unnecessaryPending, 1);
  assert.equal(result.unnecessaryPendingRate, .5);
});
test('owner decisions do not turn pending analyses into verified ground truth', () => {
  const result = evaluateLabels(validateLabels(document([label(1)])), [
    event(1, 'pending'), event(1, 'manual_confirmed', { id: '2', event_type: 'decision', created_at: '2026-09-10T03:00:00Z' }),
  ]);
  assert.equal(result.unnecessaryPending, 1);
  assert.equal(result.labeledAutoApprovals, 0);
  assert.equal(result.falseApprovalRate, null);
  assert.throws(() => validateLabels(document([label(1, { evidenceSource: 'owner_confirmation' })])), /independent/);
});
test('payment received alone cannot label a wrong receipt as eligible', () => {
  const result = evaluateLabels(validateLabels(document([label(1, { receiptMatchesBooking: false })])), [event(1, 'auto_valid')]);
  assert.equal(result.falseApprovals, 1);
  assert.equal(result.labeledEligibleReceipts, 0);
});
test('duplicate hashes, incomplete truth and unreferenced claims are rejected', () => {
  assert.throws(() => validateLabels(document([label(1), label(1)])), /repeated/);
  assert.throws(() => validateLabels(document([label(1, { evidenceReference: '' })])), /independent/);
  assert.throws(() => validateLabels(document([label(1, { receiptMatchesBooking: undefined })])), /receiptMatchesBooking/);
  assert.throws(() => validateLabels(document([label(1, { reviewedAt: 'not a date' })])), /reviewedAt/);
});
test('retries are one receipt and latest analysis wins, irrespective of owner outcome', () => {
  const result = evaluateLabels(validateLabels(document([label(1)])), [
    event(1, 'pending'), event(1, 'auto_valid', { id: '3', created_at: '2026-09-10T02:00:00Z' }),
    event(1, 'manual_confirmed', { id: '4', event_type: 'decision', created_at: '2026-09-10T03:00:00Z' }),
  ]);
  assert.equal(result.matchedLabels, 1);
  assert.equal(result.unnecessaryPending, 0);
  assert.equal(result.labeledAutoApprovals, 1);
});
test('no matching independent truth leaves correctness rates unavailable', () => {
  const result = evaluateLabels(validateLabels(document([label(1)])), [event(2, 'auto_valid')]);
  assert.equal(result.falseApprovalRate, null);
  assert.equal(result.unnecessaryPendingRate, null);
});
test('same image reused on a different booking cannot reuse an original truth label', () => {
  const result = evaluateLabels(validateLabels(document([label(1)])), [
    event(1, 'auto_valid'), event(1, 'pending', { id: '2', booking_ref: 'DIFFERENT-BOOKING', created_at: '2026-09-10T02:00:00Z' }),
  ]);
  assert.equal(result.labeledAutoApprovals, 1);
  assert.equal(result.unnecessaryPending, 0);
  assert.throws(() => validateLabels(document([label(1, { bookingRef: '' })])), /bookingRef/);
});
