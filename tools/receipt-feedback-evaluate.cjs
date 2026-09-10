'use strict';

// Offline labels must come from receiving-account reconciliation and a separate
// receipt/booking check. Owner confirmation and OCR output are not truth labels.
function validateLabels(document) {
  if (document?.version !== 'receipt_reconciliation_labels_v1' || !Array.isArray(document.labels) || document.labels.length > 200) {
    throw new Error('Labels require receipt_reconciliation_labels_v1 and at most 200 independently reconciled labels.');
  }
  const seen = new Set();
  return document.labels.map((label, index) => {
    if (!/^[0-9a-f]{64}$/.test(label?.receiptImageHash || '') || seen.has(label.receiptImageHash)) throw new Error(`Invalid or repeated receipt hash in label ${index + 1}.`);
    if (typeof label.bookingRef !== 'string' || !label.bookingRef.trim() || label.bookingRef.length > 100) throw new Error(`Label ${index + 1} requires the independently reviewed bookingRef.`);
    if (label.evidenceSource !== 'receiving_account_reconciliation' || typeof label.evidenceReference !== 'string' || !label.evidenceReference.trim() || label.evidenceReference.length > 200) {
      throw new Error(`Label ${index + 1} requires independent receiving-account evidence; owner confirmation is insufficient.`);
    }
    if (!['received', 'not_received'].includes(label.paymentOutcome) || typeof label.receiptMatchesBooking !== 'boolean' || typeof label.reviewedAt !== 'string' || !Number.isFinite(Date.parse(label.reviewedAt))) {
      throw new Error(`Label ${index + 1} requires paymentOutcome, receiptMatchesBooking, and reviewedAt.`);
    }
    seen.add(label.receiptImageHash);
    return { receiptImageHash: label.receiptImageHash, bookingRef: label.bookingRef, eligibleForApproval: label.paymentOutcome === 'received' && label.receiptMatchesBooking };
  });
}

function evaluateLabels(labels, events) {
  const latest = new Map();
  for (const event of events) {
    if (event.event_type !== 'analysis' || !['auto_valid', 'pending'].includes(event.outcome)) continue;
    const key = event.receipt_image_hash + ':' + event.booking_ref;
    const previous = latest.get(key);
    if (!previous || new Date(event.created_at).valueOf() > new Date(previous.created_at).valueOf() ||
      (event.created_at === previous.created_at && BigInt(event.id) > BigInt(previous.id))) latest.set(key, event);
  }
  let matched = 0; let autoApprovals = 0; let falseApprovals = 0; let eligibleReceipts = 0; let unnecessaryPending = 0;
  for (const label of labels) {
    const event = latest.get(label.receiptImageHash + ':' + label.bookingRef);
    if (!event) continue;
    matched++;
    if (event.outcome === 'auto_valid') {
      autoApprovals++;
      if (!label.eligibleForApproval) falseApprovals++;
    }
    if (label.eligibleForApproval) {
      eligibleReceipts++;
      if (event.outcome === 'pending') unnecessaryPending++;
    }
  }
  return {
    source: 'provided_independent_reconciliation_labels',
    labelsProvided: labels.length, matchedLabels: matched, unmatchedLabels: labels.length - matched,
    labeledAutoApprovals: autoApprovals, falseApprovals,
    falseApprovalRate: autoApprovals ? falseApprovals / autoApprovals : null,
    labeledEligibleReceipts: eligibleReceipts, unnecessaryPending,
    unnecessaryPendingRate: eligibleReceipts ? unnecessaryPending / eligibleReceipts : null,
    note: 'Offline evaluation of the latest matching OCR analysis only. Rates describe supplied labels, not all payments. Label evidence is supplied by the operator; this tool does not independently verify it. No labels or outcomes are written to the database.',
  };
}

module.exports = { validateLabels, evaluateLabels };
