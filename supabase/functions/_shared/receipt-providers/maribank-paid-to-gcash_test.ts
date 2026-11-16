import { isMaribankBookingPaidToGcash } from "./maribank-paid-to-gcash.ts";
import { parseProviderReceipt, verifyProviderReceipt, type ReceiptVerificationContext } from "./index.ts";

function assert(a: unknown, m = "assertion") {
  if (!a) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
const check = (originalText: string, over: Partial<Parameters<typeof isMaribankBookingPaidToGcash>[0]> = {}) =>
  isMaribankBookingPaidToGcash({
    provider: "maribank",
    originalText,
    gcashLayoutText: originalText,
    gcashMerchantNumber: "09601234169",
    ...over,
  });

// GCash Express Send to the court's GCash (synthetic numbers, real layout).
const gcashExpressSend = `Express Send
KR••••E L•• C.
+63 960 123 4169
Sent via GCash
Amount
265.00
Total Amount Sent
₱265.00
Ref No. 9045088203104 Nov 14, 2026 7:18 PM`;

// MariBank app "Transfer Result" to G-Xchange/GCash (real layout, sender replaced).
const maribankAppToGcash = `4:51
Transfer Result
Transfer Successful!
PHP 530.00
From SAMPLE S.
MariBank: 11111111111
To Kr****e L** C.
G-Xchange/GCash
Acct No.: DWQM4TK3JDNZU9W07
Transfer Amount PHP 530.00
Transfer Fee FREE
Total Amount PHP 530.00
Reference Number 659872
Transfer Method instaFay
Processing Time Realtime`;

const gcashToMaribank = `Bank Transfer Complete
Sent via GCash
Bank
MariBank
Account No.
.......7144
Account Name
KRISTIE LOU V.
Transfer Method
InstaPay
Transfer Amount
265.00
+Fee
10.00
Total
P 275.00
Date
Nov 12, 2026 06:44 PM
InstaPay Invoice No.
9397168
Ref No.
8047182178021`;

Deno.test("a MariBank booking with a clear GCash app receipt takes the GCash route", () => {
  assert(check(gcashExpressSend), "GCash Express Send not routed");
});

Deno.test("the GCash route never applies to other bookings, layouts or missing settings", () => {
  assert(!check(gcashExpressSend, { provider: "gcash" }), "GCash booking rerouted");
  assert(!check(gcashExpressSend, { provider: "gotyme" }), "GoTyme booking rerouted");
  assert(!check(gcashExpressSend, { gcashMerchantNumber: "" }), "no GCash merchant configured");
  assert(!check(gcashToMaribank), "GCash-to-MariBank must stay with the MariBank verifier");
  assert(!check(maribankAppToGcash), "MariBank-app-to-GCash cannot prove it is new");
  assert(!check(""), "empty text");
  // GCash's email notice of a transfer to MariBank (real 2026-11-15 layout).
  assert(!check(`noreply-banktransfer@gcash.com
GCash Bank Transfer
Successfully Transferred! Sent via GCash Bank MariBank
Sent GCash to MariBank with
account ending in 7144
Amount
-275.00
Date & Time
Nov 15, 2026 1:01PM
Reference Number
8047288337058`), "GCash notice of a MariBank transfer");
  assert(!check("Your transaction has been processed.\nMBAEE26111418003439693842"), "other bank app");
});

Deno.test("the GCash verifier still decides every detail against the GCash merchant", () => {
  const context: ReceiptVerificationContext = {
    expectedAmount: 265,
    pricingAvailable: true,
    amountTolerance: .01,
    expectedRecipientNumber: "09601234169",
    expectedRecipientName: "KRISTIE LOU CACHUELA",
    bookingStartedAt: "2026-11-14T11:10:00Z",
    bookingStartedDate: "2026-11-14",
    paymentWindowMinutes: 15,
    earlyToleranceMinutes: 2,
  };
  const flags = (text: string, over: Partial<ReceiptVerificationContext> = {}) =>
    verifyProviderReceipt(parseProviderReceipt("gcash", text, {}), { ...context, ...over }).flags;
  eq(flags(gcashExpressSend), []);
  assert(flags(gcashExpressSend, { expectedAmount: 530 }).length > 0, "wrong amount accepted");
  assert(flags(gcashExpressSend, { expectedRecipientNumber: "09601234999" }).length > 0, "other GCash number accepted");
  // Paid 21 minutes after the booking started (the real 2026-11-14 case).
  assert(flags(gcashExpressSend, { bookingStartedAt: "2026-11-14T10:57:00Z" }).includes("TIME_EXPIRED"), "late payment accepted");
});
