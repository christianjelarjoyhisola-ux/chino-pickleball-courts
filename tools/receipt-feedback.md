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

Bank-provider example:

`node tools/receipt-feedback-report.cjs --days=30 --provider=maya --destination=gcash --layout=maya_sent_money_v1 --revision=bank_adaptive_20260910`

The server-only `receipt_preferred_provider_reading_strategy(p_provider,p_destination_provider,p_layout,p_parser_revision)`
uses the same response and five-distinct-image minimum. It isolates observations
by sending provider, receiving route, recognized layout, and verifier revision.
It accepts only the compiled `bank_full_contrast_v1` and `bank_full_enlarged_v1`
recovery strategies. `bank_original_v1` is measured but is never a recovery
preference. A clean sample must have a clean server receipt audit, native OCR,
at least 90% actual payment-field confidence, and all verification checks passed.
Page-average confidence is retained separately; it is not replaced with a learned
score. Preferences do not learn identities, expected amounts, references, or
payment tolerances. All required recovery reads and verification checks still run.
`bank_gotyme_recipient_pair_v1` is also recorded for GoTyme only; a recipient crop
cannot become the preferred full-receipt strategy.

Supported provider/route/layout combinations:

| Provider | Destination | Recognized layout |
| --- | --- | --- |
| Maya | GCash | `maya_sent_money_v1` |
| BDO Pay | GCash | `bdopay_sent_instapay_v1` |
| BPI | GCash | `bpi_transfer_success_v1` |
| GoTyme | GCash | `gotyme_transferred_v1`, `gotyme_transfer_success_v1` |
| MariBank | GCash | `maribank_money_sent_v1` |
| Security Bank method | Security Bank | `securitybank_gcash_transfer_v1` (sent through GCash) |

Unknown layouts and PNB do not produce eligible learning samples. Existing GCash
preferences remain compatible without historical backfills. The report preserves
its existing fields and adds `byProvider`, `byRoute`, `byLayout`,
`byProviderRouteRevision`, and `byProviderStrategy`. Those breakdowns keep
provider/route/layout boundaries; their totals need not sum to the global
distinct-image total when the same image was submitted in different scopes.

The optional `--labels-file=.private/receipt-reconciliation-labels.json` evaluates
the latest OCR analysis matching each independent label. Add layout and revision
options to scope that evaluation to one release, and provider/destination options
for one route. The file stays private and no
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
* `node --test tools/receipt-feedback-report.test.cjs`
* `node tools/receipt-feedback-test.cjs --rollback-live`

The database test applies both feedback migrations inside one transaction, uses
synthetic negative-ID audit rows, and always rolls back. It never updates bookings
or financial records. Do not replace its rollback with a commit.
