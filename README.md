# CHINO Pickleball Courts

CHINO's independent court booking and operations platform, with a court-blue, charcoal, and concrete visual identity inspired by the supplied venue photograph.

- Website: [chinopickleballcourt.com](https://chinopickleballcourt.com)
- Private repository: [christianjelarjoyhisola-ux/chino-pickleball-courts](https://github.com/christianjelarjoyhisola-ux/chino-pickleball-courts)
- Dedicated Supabase project: `wskzptxekldhsxluhgos` — Singapore (`ap-southeast-1`)
- Independent Supabase organization: [CHINO Pickleball Courts](https://supabase.com/dashboard/org/xvtjpartlhxcyirwkhgo)

Adapted from the owner's Paddle Rage Pickleball platform. This project retains its booking and operations features while using independent CHINO data, accounts, configuration, and branding.

## Included features

Public court availability and multi-court booking, temporary slot holds, tiered pricing, booking confirmations, private booking management, individual and grouped rescheduling, host applications and reservations, host deposits and balance payments, receipt verification and owner review, Open Play registration, match management and rankings, live spectator links, result and availability graphics, maintenance scheduling, role-based accounts, owner insights, reporting, and remittances.

## Venue setup

The owner can configure CHINO's courts, hours, rates, payment recipients, contact details, and policies through the dashboard. A fresh project starts without sample courts. Payment methods remain disabled until configured; setup does not reuse another venue's merchant information. The starting internal allocation rate is zero.

Venue address: [Prk. Bautista, Mankilam, Tagum City](https://maps.app.goo.gl/7Su6CtSH7HCbpn1K6).

The date fallback `2026-01-01` is an internal lower bound, not an advertised opening date. Public bookings also enforce today's date in Manila time. Set a different launch boundary consistently in the browser, Edge Functions, and database if CHINO later needs an advance-booking restriction.

## Brand assets

- Court photograph: `assets/chino-courts.png`
- Official logo: `logochino.jpg` (owner-supplied original)
- Welcome-screen logo: `assets/chino-logo-transparent.png` (clean transparent cutout of the original, optimized for web)
- Shared theme: `brand-theme.css`
- Core palette: court blue `#3E79B5`, charcoal `#17222C`, concrete `#DCE2E5`

## Local preview

Serve the folder over HTTP:

```powershell
npm install
npm run dev
```

Open `http://localhost:8788/?localData=1` for isolated browser demo data. Open `http://localhost:8788/?remoteData=1` to use CHINO's Supabase project. Demo courts and accounts are restricted to the explicit local preview.

## Deployment

1. Keep deployment credentials in the ignored `.env.local`, following `.env.example`.
2. Run `npm test` and `npm run check`.
3. Apply database migrations and deploy Edge Functions using `deploy-edge-functions.ps1`.
4. Publish the static application with `deploy-cloudflare-pages.ps1` using CHINO's Pages project.
5. Verify public availability, login, booking management, and the integrations that have been configured.

For a new database, follow `SETUP_NEW_SUPABASE.sql` and its migration instructions. For an existing database, apply `supabase/migrations`; do not rerun initial setup over established venue settings. Deleting all courts must leave the court list empty until an owner adds another court.

## Optional integrations

Receipt OCR uses server-side Google Cloud Vision. Email notifications use Maileroo with a verified CHINO sending address. Telegram alerts and PayMongo checkout use separately configured credentials. See [Google Vision setup](GOOGLE_VISION_SETUP.md), [payment setup](PAYMENT_SETUP.md), and [Maya receipt verification](MAYA_RECEIPT_VERIFICATION.md).

Integration code is included. Each provider becomes operational after its credentials and venue settings are configured and its end-to-end flow is verified. Provider secrets, service-role keys, customer exports, and local deployment caches do not belong in Git or browser code.

## Weather closures

Owners and court owners can open **Weather Closures** to select booked or vacant court hours, review affected reservations, and close slots for rain, wet courts, or unsafe weather. Guests see the closure reason. Database checks also reject booking attempts from stale pages.

Affected booking groups receive a private replacement link. Each affected reservation moves its full original duration on the same court, with its price, payments, booking fee and reference unchanged. Weather replacements bypass the ordinary notice cutoff and confirm immediately after a fresh availability check. Reopening a closure preserves replacement rights. Host balance deadlines pause while affected and follow the replacement date afterwards.

Email jobs are processed every minute with delivery leases and automatic retries. The owner desk displays delivery status, allows resending, and provides a private link for players whose booking has no valid email. A successful send means provider acceptance; inbox delivery is not guaranteed. Weather closures remain owner-controlled; this feature does not automatically close courts from a forecast or individually move Open Play registrations.

`supabase/tests/weather-closures.sql` exercises the database workflow in a rollback-only transaction. `weather.test.js` covers slot scoping and public UI helpers. Include all `weather-*` assets and `weather.css` in Pages releases, and deploy `weather-notifications` together with migration `20260921100000`.
