# CHINO payment setup

CHINO includes receipt-based payment review and optional server-created PayMongo checkout. A fresh installation has all payment methods disabled and contains no merchant account or QR code. The owner chooses which methods to enable after entering the correct recipient information.

## Receipt-based payments

1. Open the dashboard's payment settings.
2. Enter CHINO's recipient name, account or mobile number, and QR image for the relevant method.
3. Enable only the methods the venue accepts.
4. Configure `GOOGLE_VISION_API_KEY` in the dedicated Supabase project if automatic receipt OCR is desired.
5. Verify a controlled booking and receipt through the final payment review state.

GCash, BDO Pay, Maya, BPI, GoTyme, MariBank, and PNB share the existing receipt workflow with provider-specific checks where implemented. An unavailable OCR provider leaves the receipt for manual review. Cash can be enabled separately for the venue's approved cash-booking process.

See [Google Vision setup](GOOGLE_VISION_SETUP.md) and [Maya receipt verification](MAYA_RECEIPT_VERIFICATION.md).

## Database and Edge Functions

Use CHINO's dedicated project `mtomskztsvljvzgmewav`. Apply the consolidated setup and every required forward migration; payment functionality depends on the full schema, authorization rules, and receipt audit tables.

The deployment script publishes the relevant functions, including `verify-gcash-receipt`, `host-booking-balance-payment`, `create-payment-session`, and `payment-webhook`. Functions use server-held service credentials; those credentials never belong in browser code.

## Optional PayMongo checkout

The checkout function supports `PAYMENT_PROVIDER=paymongo`. Static URL templates are not implemented. Configure these server secrets for CHINO:

- `PAYMONGO_SECRET_KEY`
- `PAYMENT_WEBHOOK_SECRET`
- `PAYMENT_SUCCESS_URL=https://chinopickleball.pages.dev/?payment=success`
- `PAYMENT_CANCEL_URL=https://chinopickleball.pages.dev/?payment=cancelled`

A successful session response contains a newly created provider checkout URL and a canonical booking amount. Merely visiting the return URL does not prove payment.

## Current webhook contract

The endpoint is `https://mtomskztsvljvzgmewav.supabase.co/functions/v1/payment-webhook`.

It accepts a POST body with `session_id` or `booking_ref`, `status`, and optional `provider_reference` and `paid_at` fields. It also parses PayMongo-shaped event data. Authentication currently requires an `x-payment-signature` header containing the lowercase hexadecimal HMAC-SHA256 of the exact raw request body, using `PAYMENT_WEBHOOK_SECRET`.

Native PayMongo webhook signature authentication is not implemented in this handler. Before enabling provider checkout, either implement and verify native signature validation or connect a trusted server adapter that validates the provider event and signs this endpoint's exact contract. Unsigned requests and requests without a configured secret are rejected.

## Verification

Verify the configured flow with a controlled transaction: session amount, signed callback acceptance, invalid-signature rejection, correct booking-group update, duplicate callback behavior, and the final displayed payment state. Maileroo notifications require their own configured CHINO sender credentials.
