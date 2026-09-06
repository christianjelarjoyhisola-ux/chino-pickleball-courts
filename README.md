# Paddle Rage Pickleball

A standalone pickleball court booking and operations platform with public reservations, Open Play hosting, receipt verification, payments, admin reporting, and role-based access. Production is served at `https://paddleragecdo.ph` and uses a dedicated Supabase project.

Receipt OCR runs server-side through Google Cloud Vision. Customer confirmation and reschedule messages use Maileroo from the verified `paddleragecdo.ph` sending domain; no provider secret is shipped to the browser.

## Brand system

- Primary logo: `paddleragelogo.jpg`
- Primary background: `#050706`
- Surface: `#0B0F0C`
- Neon green: `#B6F000`
- Bright accent: `#D7FF3F`
- Shared brand overrides: `brand-theme.css`

## Production deployment

1. Copy `.env.example` to the ignored `.env.local` and fill in Paddle Rage's deployment credentials. Never commit this file.
2. Review [GOOGLE_VISION_SETUP.md](GOOGLE_VISION_SETUP.md).
3. Run `npm test` and `npm run check`.
4. Run `deploy-edge-functions.ps1`; it applies migrations before publishing functions and fails closed when required remote integration secrets are missing.
5. Authenticate with `wrangler login` (or set a scoped `CLOUDFLARE_API_TOKEN`), then run `deploy-cloudflare-pages.ps1` to publish the static site.
6. Verify the custom domain, Edge Function health, one receipt flow, and one delivered confirmation email after release.

For a fresh database, follow `SETUP_NEW_SUPABASE.sql` and its migration follow-up instructions. Setup creates no sample courts; add the venue's real courts through the admin dashboard. For an existing database, apply `supabase/migrations` instead of rerunning `SETUP_NEW_SUPABASE.sql` or `setup-db.js`, which also initialize settings and policies. An empty court list is valid and must stay empty until an admin adds a court.

## Local preview

Serve the folder over HTTP; do not open the HTML files directly. For example:

```powershell
npm run dev
```

Open `http://localhost:8788/?localData=1` to use isolated browser demo data without a Supabase connection.

Use the explicit `localData=1` mode for sample courts and demos. Keep sample court data out of production; deleting a court must not trigger automatic sample seeding on reload, reconnect, or deployment.

## Checks

```powershell
npm test
npm run check
```

## Separation checklist

- Use a new Supabase organization/project and fresh admin accounts.
- Use a new Cloudflare Pages project, domain, analytics property, and AdSense account if ads are later enabled.
- Verify Paddle Rage's sending domain in Maileroo and use a new sending key, Telegram bot/chat, PayMongo keys, payment webhook secret, OCR key, and merchant QR images.
- Review all legal text, operating hours, prices, policies, location, and payment instructions before production. Create only the venue's real courts and keep demo content in local preview.
- Have qualified Philippine counsel review the included platform agreement and privacy/consumer terms before accepting real bookings.
- Do not copy `.env.local`, browser local storage, service-role keys, database exports, or deployment caches from another venue.
