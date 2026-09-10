Receipt performance reporting
=============================

`node tools/receipt-feedback-report.cjs --days=30 --layout=gcash_express_send --revision=gcash_adaptive_20260910`

This read-only command uses the CHINO credentials in `.env.local`. It reports
distinct-receipt outcomes, pending reasons, native OCR call counts, reading time,
confidence, and fixed-strategy performance. Owner decisions are workflow outcomes,
not proof that a receipt was valid or that a transfer arrived. Correctness remains
unavailable in the database report. Telemetry starts when the migration is applied;
historical receipt audits remain unchanged.

The server-only `receipt_preferred_reading_strategy(p_layout,p_parser_revision)`
returns `{strategy,eligibleSamples,minimumSamples:5,stats}`. `strategy` is null
until at least five distinct images produced clean, native-confident evidence for
that fixed strategy under the same recognized layout and current revision. This
preference changes reading order/canonical choice only; both required recovery
reads and all payment safeguards still run. Unknown layouts and owner approvals
cannot teach successful OCR. Both metrics RPCs fail closed on unauthorized calls;
telemetry capture fails open so an outage cannot block payment processing.

The optional `--labels-file=.private/receipt-reconciliation-labels.json` evaluates
the latest OCR analysis matching each independent label. Add layout and revision
options to scope that evaluation to one release. The file stays private and no
labels are written to the database. Example schema (replace the illustrative hash
and reference with independently reviewed evidence):

```json
{
  "version": "receipt_reconciliation_labels_v1",
  "labels": [
    {
      "receiptImageHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bookingRef": "independently reviewed booking reference",
      "paymentOutcome": "received",
      "receiptMatchesBooking": true,
      "evidenceSource": "receiving_account_reconciliation",
      "evidenceReference": "private reconciliation record",
      "reviewedAt": "2026-09-10T02:00:00Z"
    }
  ]
}
```

`receiptMatchesBooking` must come from a separate review of receipt reference,
amount, recipient, date/time and booking. Owner confirmation and OCR output alone
are insufficient. The hash and booking reference must both match the audited
analysis, so a later duplicate upload cannot reuse the original truth label.
A label is eligible for approval only when payment was received
and the receipt matches the booking. Labeled false approvals are automatic passes
that fail that independent label; their rate uses labeled automatic passes as its
denominator. Labeled unnecessary pending cases are pending analyses with eligible
labels; their rate uses all labeled eligible receipts as its denominator. These
rates apply only to the provided labeled sample; the CLI cannot verify the operator's
evidence independently. Zero applicable labels produces null rates.

Validation commands:

* `node --test tools/receipt-feedback-evaluate.test.cjs`
* `node tools/receipt-feedback-test.cjs --rollback-live`

The database test applies the candidate migration inside a transaction, uses
synthetic negative-ID audit rows, and always rolls back. It never updates bookings
or financial records. Do not replace its rollback with a commit.
