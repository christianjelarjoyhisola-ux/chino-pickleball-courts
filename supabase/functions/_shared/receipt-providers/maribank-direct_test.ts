import {
  parseProviderReceipt,
  type ReceiptVerificationContext,
  verifyProviderReceipt,
} from "./index.ts";
import {
  parseMaribankDirectReceipt,
  verifyMaribankDirectReceipt,
} from "./maribank-direct.ts";
import { maribankDirectApprovalConfidence } from "../bank-ocr-evidence.ts";
import { bankFixtureRead } from "../bank-ocr-fixtures.ts";
function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}
function assert(a: unknown, m = "assertion") {
  if (!a) throw new Error(m);
}
const context: ReceiptVerificationContext = {
  expectedAmount: 795,
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientName: "KRISTIE LOU VILLANUEVA",
  expectedRecipientNumber: "15521507144",
  bookingStartedAt: "2026-10-06T08:18:00Z",
  bookingStartedDate: "2026-10-06",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};
const native = `4:21 PM
Transfer Result
From
To
Transfer Successful!
PHP 795.00
Transfer Amount
Transfer Fee
Total Amount
Reference Number
SAMPLE SENDER
MariBank: 11111111111
Kristie Lou V.
MariBank
Acct. No.: 15521507144
PHP 795.00
FREE
PHP 795.00
BC550000000000000001
Transaction Date & Time
06 Oct 2026, 16:20
Share
Done`;
const gcash = `Bank Transfer Complete
Sent via GCash
Bank
MariBank
Account No.
Account Name
Transfer Method
Receipt sent to
15521507144
KRISTIE LOU VILLANUEVA
InstaPay
test@example.invalid
Transfer Amount
+Fee
Total
Date
InstaPay Invoice No.
Ref No.
795.00
10.00
P 805.00
Oct 06, 2026 04:20 PM
1234567
1234567890123
Powered by instaPay`;
const flags = (
  text: string,
  override: Partial<ReceiptVerificationContext> = {},
) =>
  verifyMaribankDirectReceipt(parseMaribankDirectReceipt(text), {
    ...context,
    ...override,
  }).flags;
Deno.test("direct MariBank and GCash receipts verify destination, principal and Philippine timestamp", () => {
  for (const text of [native, gcash]) {
    const p = parseProviderReceipt("maribank_direct", text);
    eq(p.destinationProvider, "maribank");
    eq(p.receipt.amount.amount, 795);
    eq(p.receipt.timestamp.instant, "2026-10-06T08:20:00.000Z");
    eq(verifyProviderReceipt(p, context).flags, []);
  }
});
Deno.test("GCash row, mixed-column and column layouts retain original field identities", () => {
  const variants = [
    gcash,
    gcash.replace(
      "Bank\nMariBank\nAccount No.\nAccount Name\nTransfer Method\nReceipt sent to\n15521507144\nKRISTIE LOU VILLANUEVA\nInstaPay",
      "Bank\nAccount No.\nAccount Name\nTransfer Method\nMariBank\n••••7144\nKRISTIE LOU V.\nInstaPay\nReceipt sent to",
    ),
    gcash.replace(
      "Account No.\nAccount Name\nTransfer Method\nReceipt sent to\n15521507144\nKRISTIE LOU VILLANUEVA\nInstaPay",
      "Account No.: 15521507144\nAccount Name: KRISTIE LOU VILLANUEVA\nTransfer Method: InstaPay\nReceipt sent to",
    ),
  ];
  for (const text of variants) eq(flags(text), []);
});
Deno.test("wrong recipient, sender identity, conflicting amounts and fee-inclusive amounts require review", () => {
  for (
    const [text, expected] of [
      [
        native.replace("Acct. No.: 15521507144", "Acct. No.: 11111111111"),
        "RECEIVER_ACCOUNT_MISMATCH",
      ],
      [
        native.replace("Kristie Lou V.", "Another Person"),
        "RECEIVER_NAME_MISMATCH",
      ],
      [native.replace("To\n", ""), "MARIBANK_RECIPIENT_SECTION_UNREADABLE"],
      [native.replace("PHP 795.00", "PHP 895.00"), "MARIBANK_AMOUNT_CONFLICT"],
      [gcash.replace("P 805.00", "P 795.00"), "MARIBANK_TOTAL_MISMATCH"],
      [gcash.replace("15521507144", "xxxx144"), "RECEIVER_ACCOUNT_MISMATCH"],
    ]
  ) assert(flags(text).includes(expected), expected);
  assert(flags(gcash, { expectedAmount: 805 }).includes("AMOUNT_MISMATCH"));
  assert(
    flags(native, { expectedRecipientNumber: "" }).includes(
      "MERCHANT_CONFIG_MISSING",
    ),
  );
});
Deno.test("pending, reversed, cropped and old-destination receipts cannot auto verify", () => {
  for (
    const text of [
      native + "\nReversed",
      native + "\nPending",
      native.replace("Transfer Successful!", "Transaction Receipt"),
      gcash.replace("Bank Transfer Complete", ""),
      native.replace("MariBank\nAcct.", "G-Xchange / GCash\nAcct."),
    ]
  ) assert(flags(text).length > 0);
});
Deno.test("timestamps require a real complete date inside the booking window", () => {
  for (
    const text of [
      native.replace("06 Oct 2026, 16:20", "16:20"),
      native.replace("06 Oct 2026, 16:20", "31 Feb 2026, 16:20"),
      native.replace("16:20", "24:20"),
      native.replace("16:20", "16:59"),
      native.replace("16:20", "16:00"),
    ]
  ) assert(flags(text).length > 0);
});
Deno.test("reference checks never use typed input as OCR evidence and namespaces block cross-method reuse", () => {
  const p = parseMaribankDirectReceipt(native, {
    typedReference: "BC550000000000000002",
  });
  assert(
    verifyMaribankDirectReceipt(p, context).flags.includes("REF_MISMATCH"),
  );
  const missing = parseMaribankDirectReceipt(
    native.replace("BC550000000000000001", ""),
    { typedReference: "BC550000000000000001" },
  );
  eq(missing.reference.value, null);
  eq(
    verifyMaribankDirectReceipt(parseMaribankDirectReceipt(native), context)
      .dedupeKeys.map((k) => k.key),
    ["maribank:BC550000000000000001"],
  );
  eq(
    verifyMaribankDirectReceipt(parseMaribankDirectReceipt(gcash), context)
      .dedupeKeys.map((k) => k.key),
    [
      "maribank:1234567890123",
      "1234567890123",
      "gcash_instapay_invoice:1234567",
    ],
  );
  assert(
    flags(native + "\nBC550000000000000002").includes(
      "MARIBANK_AMBIGUOUS_FIELDS",
    ),
  );
});
Deno.test("auto verification requires native confidence for every field, not page-average confidence", () => {
  for (const text of [native, gcash]) {
    const p = parseProviderReceipt("maribank_direct", text);
    if (p.provider !== "maribank_direct") throw Error("wrong parser");
    const read = bankFixtureRead(text);
    const approval = maribankDirectApprovalConfidence(read, p);
    eq(approval.confidence, .97);
    assert(approval.complete);
    const weak = bankFixtureRead(text);
    for (const word of weak.nativeLines!.flatMap((l) => l.words)) {
      if (word.text === "15521507144") {
        word.confidence = .4;
        word.symbols.forEach((s) => s.confidence = .4);
      }
    }
    assert(maribankDirectApprovalConfidence(weak, p).confidence < .9);
    eq(
      maribankDirectApprovalConfidence({
        ...read,
        nativeLines: [],
        confidence: 1,
      }, p).confidence,
      0,
    );
  }
});
