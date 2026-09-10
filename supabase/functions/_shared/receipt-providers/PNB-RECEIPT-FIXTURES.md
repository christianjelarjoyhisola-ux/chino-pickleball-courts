# PNB receipt support

PNB remains owner-review-only. The repository has a PNB payment option and
merchant configuration, but no representative PNB receipt image or captured OCR
fixture as of 2026-09-10. A payment icon or account QR is not a receipt fixture.

Before enabling a dedicated PNB parser and verifier, obtain an original completed
receipt for the configured payment route and independently verify its recipient,
credited amount, fees, reference identifiers, and Philippine timestamp. Retain
the original image and native OCR response privately; use sanitized text and
geometric fixtures in tests. Do not substitute merchant settings for unread OCR.

Test actual supported layouts, including masked account variants, against
processing/failed/reversed receipts, conflicting amounts, wrong recipients,
incorrect dates and references, and reused receipt/payment-rail identifiers.
Only then add the dedicated registry entry, bounded OCR recovery, and database
auto-approval contracts together. Until those fixtures pass, PNB receipts remain
available for normal owner confirmation and must not report automatic approval.
