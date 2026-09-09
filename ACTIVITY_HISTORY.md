# Management activity history

The system owner (`accounts.role = owner`, active) can open **Admin → Activity History**. Court owners, staff, hosts, and public visitors cannot read the history through the page, direct table API, or history RPCs. Application accounts cannot edit, delete, truncate, or insert authoritative history rows.

Recording starts at installation. Earlier actions are not reconstructed.

The Operator filter includes all system-owner, court-owner, and staff accounts, even before their first recorded activity and regardless of account status. Historical operators remain selectable after an account is removed or changes role. Existing accounts use their current name and role; saved events retain the identity recorded at the time. The directory stays available when the selected filters return no events.

## What is recorded

- Committed inserts, updates, and deletes across public business tables: courts and pauses, bookings and payments, schedules, settings, promotions, maintenance, Open Play, accounts, and finance. Before/after values and changed field names are retained. No-op and rolled-back changes are not presented as completed changes.
- Authenticated management Edge requests, including receipt actions, account management, host reviews, notifications, emails, and balance operations. A validated user ID and server-generated request ID link these requests to service-role database writes. HTTP success means the request completed, not that a payment was approved or an email was delivered.
- Browser-reported page views, management action attempts, exports/printing, sign-in/sign-out, password-change outcomes, and database-adapter operation results. These are labelled as reported observations, separate from confirmed database changes. Browser reports can be unavailable offline or after browser interruption and are limited to 120 events per account per minute. This does not suppress database-change records.
- Authentication-service events when Supabase emits them to `auth.audit_log_entries`. The API separately reports whether the hook is installed and whether any such events have actually been observed. Browser sign-in reports remain separate.

No passwords, authentication tokens, receipt images, identity-document paths, wallet/account numbers, or entered form contents are collected in browser observations. Database snapshots recursively redact sensitive fields and bound large values. Changed field names remain visible when values are redacted.

Internal leases, delivery queues, receipt evidence, temporary claims, and existing audit/history tables are excluded from duplicate database capture. Resulting business changes remain covered. New public business tables are automatically registered when the platform permits the DDL hook; the capability and covered table names are available in the owner-only list response.

## Deployment and verification

Apply only `supabase/migrations/20260909230000_admin_activity_history.sql` to the dedicated CHINO project before deploying the dependent Edge Functions and frontend. The migration checks the project URL. Preserve each function's existing JWT setting; `process-host-balance-deadlines` uses its existing internal authorization with `verify_jwt = false`.

Then apply `supabase/migrations/20260909233000_activity_operator_directory.sql` to include operators with no recorded events. This follow-up replaces only the owner-only list function; it does not create or backfill activity entries. Verify it with `supabase/tests/activity_operator_directory.sql`, keeping its final rollback.

Run `supabase/tests/admin_activity_history.sql` in its rollback-only transaction to verify canonical actors, direct/RPC change capture, RLS, spoof rejection, redaction, append-only rules, pagination, rollback semantics, and optional hooks. Do not remove its final rollback when running against production.

Frontend/security checks: `npm test`, `npm run check`, and `deno test --no-check supabase/functions/_shared/admin-activity_test.ts`. Check changed Edge entrypoints with Deno before deployment. Production smoke checks must not send notifications, create bookings, or toggle courts merely to create test history.
