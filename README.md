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
