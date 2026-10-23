# Receipt OCR diagnostics

This service-only endpoint returns native Google Vision annotations for receipt
diagnostics, including already resolved payments. It performs no booking writes
and cannot mark a receipt paid or approved. It is not a browser endpoint.

Keep JWT verification enabled. The runtime service key is accepted. When the
existing trusted automation service credential differs from the runtime key,
set `OCR_DIAGNOSTIC_SERVICE_KEY_SHA256` to its SHA-256 digest through Supabase
secrets. Never put the service key in frontend code or this repository. Remove
or update the digest when that credential is retired.

`GOOGLE_VISION_API_KEY` is the same server secret used by the receipt verifier.
POST JSON with `imageBase64` and optional `feature` (`DOCUMENT_TEXT_DETECTION`
or `TEXT_DETECTION`). Bodies are limited to 8 MiB and provider calls to 20 seconds.
Public/owner tokens are denied. Diagnostic results are not cached.

Deploy with `supabase functions deploy chino-gcash-optical-check --project-ref
wskzptxekldhsxluhgos --use-api`; the project edge release script also includes it.
