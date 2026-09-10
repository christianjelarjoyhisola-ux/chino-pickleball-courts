// Text fixtures copied from existing dedicated-provider regression suites.
// Native word confidence below is synthetic test evidence, never a live score.
import type { GoogleVisionOcrResult } from "./google-vision.ts";
import type {
  BankAdaptiveProvider,
  BankProviderParse,
} from "./bank-ocr-evidence.ts";
import {
  parseProviderReceipt,
  type ReceiptVerificationContext,
} from "./receipt-providers/index.ts";
export const BANK_FIXTURES: Array<
  {
    provider: BankAdaptiveProvider;
    text: string;
    context: ReceiptVerificationContext;
  }
> = [
  {
    provider: "maya",
    text: `12:04
Sent money via
- ₱800.00
InstaPay
Sep 5, 2026, 12:02 pm
You may confirm the status of your transaction with your recipient.
Share
payment
Account type
G-Xchange Inc. / GCash
Account number
09981234567
Account name
J..KE....H M.
Transfer Fee
₱10.00
Reference ID
B794 2F55 EC99
InstaPay Ref. No
797289
maya
Get help`,
    context: {
      typedReference: "B7942F55EC99",
      expectedAmount: 800,
      pricingAvailable: true,
      amountTolerance: .01,
      expectedRecipientNumber: "09981234567",
      expectedRecipientName: "Jan Kennith Magallano",
      bookingStartedAt: "2026-09-05T03:58:00Z",
      bookingStartedDate: "2026-09-05",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    },
  },
  {
    provider: "bdopay",
    text: `Sent!
PHP 1,600.00
Sep 02, 2026 07:07 PM
Amount
PHP 1,600.00
Service Fee
PHP 0.00
Send Money via InstaPay
To
CHINO
G-XCHANGE, INC. / GCASH
CHINOTEST0000NS8
From
Meriam Plaza
•••• •••• 5751
Invoice number
961119
Reference no.
BN-20260902-69811640`,
    context: {
      typedReference: "BN2026090269811640",
      expectedAmount: 1600,
      pricingAvailable: true,
      amountTolerance: .01,
      expectedRecipientName: "CHINO",
      expectedRecipientAccount: "CHINOTEST0000NS8",
      bookingStartedAt: "2026-09-02T11:05:00Z",
      bookingStartedDate: "2026-09-02",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    },
  },
  {
    provider: "bpi",
    text: `Transfer successful!
Wednesday, Sep 02, 2026, 07:08:34 AM (GMT +8)
Confirmation No. 1624507073805
Transaction Ref. No. 099408
Sent via BPI
Transfer to
GCash/G-Xchange
CHINO (QR Code)
XXXXXXXXXXXXNS8
Transfer amount
PHP 3,600.00
Fee
PHP 0.00
Transfer from
SAVINGS ACCOUNT
XXXXXX6089
Transfer service
InstaPay`,
    context: {
      typedReference: "1624507073805",
      expectedAmount: 3600,
      pricingAvailable: true,
      amountTolerance: .01,
      expectedRecipientName: "CHINO",
      expectedRecipientAccount: "CHINOTEST0000NS8",
      bookingStartedAt: "2026-09-01T23:06:00Z",
      bookingStartedDate: "2026-09-02",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    },
  },
  {
    provider: "gotyme",
    text: `1:59
91
Transferred
₱265.00
Share
InstaPay Instant
To KR****E L** C*
****************9WO7
G-Xchange, Inc (GCash)
From SHEEJAN E*****
********4162
GoTyme Bank
Amount ₱265.00
Fee ₱0.00
Total ₱265.00
Trace ID 941016
Reference No. ITO260909055941016
Date 09 Sep 2026 at 1:59 PM`,
    context: {
      expectedAmount: 265,
      pricingAvailable: true,
      amountTolerance: .01,
      expectedRecipientNumber: "09609422169",
      expectedRecipientName: "KRISTIE LOU CACHUELA",
      expectedRecipientAccount: "TESTMERCHANT9WO7",
      bookingStartedAt: "2026-09-09T05:58:00Z",
      bookingStartedDate: "2026-09-09",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    },
  },
  {
    provider: "maribank",
    text: `MariBank
Money sent
Recipient
CHINO Pickleball Courts
GCash
Account number 0998-123-4567
Amount PHP 1,080.00
Reference No MB2026083198765432
InstaPay Reference No 987654321234
2026-08-31 10:42 AM
via InstaPay`,
    context: {
      expectedAmount: 1080,
      pricingAvailable: true,
      amountTolerance: .01,
      expectedRecipientNumber: "09981234567",
      expectedRecipientName: "CHINO Pickleball Courts",
      bookingStartedAt: "2026-08-31T02:40:00Z",
      bookingStartedDate: "2026-08-31",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    },
  },
  {
    provider: "securitybank",
    text: `Bank Transfer Complete
Sent via GCash
Successful transactions are credited instantly. You will receive
an update about this transaction in your GCash Inbox.
Bank
Security Bank
Corporation
Account No.
••••••••2980
Account Name
Kristie Lou V.
Transfer Method
InstaPay
Receipt sent to
sample@example.com
Transfer Amount
1.00
+Fee
10.00
Total
₱ 11.00
Date
Sep 09, 2026 12:52 AM
InstaPay Invoice No.
428516
Ref No.
2044841788110
228g (gCO2e)
By going digital, you reduce your carbon footprint
Powered by instaPay`,
    context: {
      typedReference: "2044841788110",
      expectedAmount: 1,
      pricingAvailable: true,
      amountTolerance: .01,
      expectedRecipientNumber: "000012342980",
      expectedRecipientName: "KRISTIE LOU VALDEZ",
      bookingStartedAt: "2026-09-08T16:50:00Z",
      bookingStartedDate: "2026-09-09",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    },
  },
];
export function bankFixtureRead(
  text: string,
  confidence = .97,
): GoogleVisionOcrResult {
  return {
    text,
    layoutText: text,
    confidence: .78,
    confidenceSource: "native",
    nativeLines: text.split("\n").map((line, row) => {
      let x = 0;
      return {
        text: line,
        page: 0,
        words: line.split(/\s+/).filter(Boolean).map((value) => {
          const left = x;
          x += value.length * 10 + 6;
          return {
            text: value,
            left,
            right: x - 6,
            top: row * 30,
            bottom: row * 30 + 20,
            confidence,
            symbols: [...value].map((text) => ({ text, confidence })),
          };
        }),
      };
    }),
  };
}
export function bankFixtureOriginal(
  fixture = BANK_FIXTURES[0],
  read = bankFixtureRead(fixture.text),
) {
  return {
    read,
    parsed: parseProviderReceipt(
      fixture.provider,
      read.layoutText || read.text,
      { typedReference: fixture.context.typedReference },
    ) as BankProviderParse,
  };
}
