# CHINO launch readiness

Checked September 8, 2026, against https://chinopickleball.pages.dev and CHINO's dedicated Singapore database.

**Verdict: the core booking system passed the checks below, but full launch sign-off is still pending payment and communication setup and one real payment review test.**

## Verified

| Area | Result |
| --- | --- |
| Automated regression checks | 492 passed; JavaScript syntax checks passed. |
| Public routes | Homepage, login, admin, host, booking management and live scoreboard routes respond successfully with CHINO branding. |
| Browser checkout | Two courts at PHP315 per hour produce PHP630 through the payment screen. Cancelling releases both slots. No payment or confirmation was submitted. |
| Availability search | Searches across the three configured courts return matching PHP315 hourly prices. |
| Anonymous customer API | A temporary hold succeeds without an owner session. The server rejects forged pricing/duration, hides the booking from a wrong access token, rejects an overlapping hold, and releases the original hold. Test records were removed. |
| Promo pricing | Database rollback tests cover date boundaries, invalid rates, owner permissions, public and host holds, regular-price caps, and existing booking totals. |
| Owner accounts | System Owner and Court Owner both sign in with their configured roles and active status. |
| Database isolation | Dedicated CHINO organization and Singapore project; internal routes target CHINO. Paddle Rage was not modified. |
| Database protection | Row-level security enabled on all 40 public tables; three receipt buckets are private. Anonymous callers cannot access private routing, owner finance or account administration. |
| Deployment history | All 87 migrations are recorded, including promo pricing. All 15 Edge Functions are active. |
| Scheduled maintenance | Hold cleanup and host-balance deadline jobs run successfully; retained HTTP callback results show successful responses. |
| Brand and assets | Supplied logo, address/map link, approved sharing description and CHINO branding retained. Referenced assets exist and are packaged for deployment. |
| Mobile appearance | Light-mode pricing inspected at 390px width; current prices and crossed-out prices are readable. Dark-mode and desktop checkout were inspected. |

## Issues fixed during this audit

- Manual bookings spanning several courts now save in one atomic operation. A conflict cannot leave an earlier court confirmed on its own.
- Login return links are restricted to the current website.
- Password recovery opens its reset form before considering an existing-session redirect.
- Empty pricing settings no longer display inherited example rates as though they were saved.
- Regular and Open Play payment choices support keyboard activation, visible focus and selected-state announcements.
- The already-applied promo migration is now recorded, preventing a future deployment from trying to apply it again.

## Complete before full launch

1. **Verify one real payment and owner review.** GCash is enabled and has a receiving number and name. This audit did not transfer money, upload a genuine payment receipt, or mark a payment received. Run one controlled booking through receipt upload, owner review, confirmation, booking management and cancellation/rescheduling as appropriate.
2. **Configure booking email delivery.** Maileroo's API key and verified sender are absent. Automatic booking emails and host-application verification emails are not ready. Existing owner login works independently.
3. **Confirm a working customer support contact.** The site displays bookings@chinopickleball.com, but mail delivery has not been verified. DNS returned no MX record; a website address record alone does not establish a working inbox. The venue contact-number field is empty.
4. **Upload the venue's GCash QR image.** The payment screen currently shows “QR not uploaded.” Manual sending to the displayed number remains available.
5. **Choose receipt verification mode.** Google Vision is unconfigured. The code routes uncertain/unavailable OCR results to owner review; automatic receipt approval is not available until configured and tested.

Telegram alerts and PayMongo checkout are also unconfigured. They are optional for a GCash/manual-review launch, but should not be advertised as operational.

## Practical launch recommendation

Use a controlled staff-only booking test first. A launch with manual payment review is possible once the receiving account, support contact and review workflow are confirmed and staff are ready to monitor the dashboard. A launch promising every automated feature requires the missing email/OCR integrations and delivery/payment tests first.

This is a tested readiness assessment, not a claim that every future failure condition has been eliminated. Email delivery, real-money settlement, provider OCR and external notifications were not exercised in this audit.
