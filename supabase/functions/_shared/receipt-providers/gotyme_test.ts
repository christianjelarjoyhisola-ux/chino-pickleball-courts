import {
  parseGotymeToGcashReceipt,
  verifyGotymeToGcashReceipt,
} from "./gotyme.ts";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function includes(actual: string[], expected: string, message: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`${message}: ${actual.join(", ")}`);
  }
}

// The screenshot's recipient section and independently labelled reference fields.
// Merchant configuration below represents trusted owner configuration, never OCR.
const OCR = `1:59
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
Date 09 Sep 2026 at 1:59 PM`;

const CONTEXT = {
  expectedAmount: 265,
  pricingAvailable: true,
  amountTolerance: 0.01,
  expectedRecipientNumber: "09609422169",
  expectedRecipientName: "KRISTIE LOU CACHUELA",
  expectedRecipientAccount: "TESTMERCHANT9WO7",
  bookingStartedAt: "2026-09-09T05:58:00.000Z",
  bookingStartedDate: "2026-09-09",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};

function verify(text = OCR, context = CONTEXT) {
  return verifyGotymeToGcashReceipt(parseGotymeToGcashReceipt(text), context);
}

Deno.test("GoTyme QR transfer extracts amount, destination, full reference, trace, and Manila date", () => {
  const parsed = parseGotymeToGcashReceipt(OCR);
  equal(
    parsed.reference.value,
    "ITO260909055941016",
    "primary reference must not be trace ID",
  );
  equal(parsed.railReference.value, "941016", "separate network trace");
  equal(parsed.amount.amount, 265, "credited amount");
  equal(parsed.amount.reliable, true, "amount reliability");
  equal(
    parsed.timestamp.instant,
    "2026-09-09T05:59:00.000Z",
    "day-first Philippine timestamp",
  );
  equal(parsed.recipient.nameRaw, "KR****E L** C*", "destination name");
  equal(parsed.recipient.accountSuffix, "9WO7", "masked QR account suffix");
  equal(
    parsed.recipient.phoneLast4,
    null,
    "sender account is not the recipient phone",
  );
  const evidence = verifyGotymeToGcashReceipt(parsed, CONTEXT);
  equal(
    evidence.recipientComparison.account,
    "suffix_only",
    "suffix-only evidence is explicit",
  );
  equal(
    evidence.recipientComparison.phone,
    "missing",
    "account is not represented as phone",
  );
  equal(
    evidence.recipientComparison.name,
    "masked_compatible",
    "visible name anchors",
  );
  equal(evidence.flags, [], "all required independently checked evidence");
  equal(evidence.dedupeKeys.map((entry) => entry.key), [
    "gotyme:ITO260909055941016",
    "instapay:941016",
  ], "two replay keys");
});

Deno.test("GoTyme supports labels and values on adjacent lines", () => {
  const text = OCR.replace("To KR", "To\nKR").replace("From SHEE", "From\nSHEE")
    .replace("Amount ₱", "Amount\n₱").replace("Fee ₱", "Fee\n₱")
    .replace("Total ₱", "Total\n₱").replace(
      "Trace ID 941016",
      "Trace ID\n941016",
    )
    .replace("Reference No. ITO", "Reference No.\nITO")
    .replace("Date 09 Sep 2026 at 1:59 PM", "Date\n09 Sep 2026\nat 1:59 PM");
  equal(verify(text).flags, [], "adjacent OCR lines preserve evidence");
});

Deno.test("GoTyme uses transfer amount without including the sender's fee", () => {
  const text = OCR.replace("Fee ₱0.00", "Fee ₱15.00").replace(
    "Total ₱265.00",
    "Total ₱280.00",
  );
  equal(
    parseGotymeToGcashReceipt(text).amount.amount,
    265,
    "amount excludes sender fee",
  );
  equal(verify(text).flags, [], "consistent fee plus amount total");
  includes(
    verify(text, { ...CONTEXT, expectedAmount: 280 }).flags,
    "AMOUNT_MISMATCH",
    "fee cannot fund booking",
  );
});

Deno.test("GoTyme conflicting amount totals remain in review", () => {
  includes(
    verify(OCR.replace("Transferred\n₱265.00", "Transferred\n₱530.00")).flags,
    "AMOUNT_UNREADABLE",
    "conflicting headline transfer",
  );
  includes(
    verify(OCR.replace("Total ₱265.00", "Total ₱530.00")).flags,
    "AMOUNT_UNREADABLE",
    "conflicting total",
  );
  includes(
    verify(OCR.replace("Amount ₱265.00", "Amount ₱65.00")).flags,
    "AMOUNT_UNREADABLE",
    "conflicting amount",
  );
  includes(
    verify(OCR.replace("Amount ₱265.00", "Amount ₱???")).flags,
    "AMOUNT_UNREADABLE",
    "unreadable amount cannot use total",
  );
});

Deno.test("GoTyme merchant suffix needs trusted configured account and compatible recipient name", () => {
  includes(
    verify(OCR, { ...CONTEXT, expectedRecipientAccount: "9WO7" }).flags,
    "MERCHANT_CONFIG_MISSING",
    "configuration must contain the full merchant account",
  );
  includes(
    verify(OCR, { ...CONTEXT, expectedRecipientAccount: "" }).flags,
    "MERCHANT_CONFIG_MISSING",
    "missing merchant config",
  );
  includes(
    verify(OCR, { ...CONTEXT, expectedRecipientAccount: "TESTMERCHANT1111" })
      .flags,
    "RECEIVER_ACCOUNT_MISMATCH",
    "wrong merchant config",
  );
  includes(
    verify(OCR.replace("9WO7", "9W07")).flags,
    "RECEIVER_ACCOUNT_MISMATCH",
    "do not repair O versus zero to match expectation",
  );
  includes(
    verify(OCR.replace("KR****E L** C*", "JO** D** R*")).flags,
    "RECEIVER_NAME_MISMATCH",
    "wrong recipient name",
  );
  includes(
    verify(OCR, { ...CONTEXT, expectedRecipientName: "" }).flags,
    "RECEIVER_NAME_UNREADABLE",
    "masked account needs configured name",
  );
});

Deno.test("GoTyme conflicting merchant accounts cannot be selected by expected configuration", () => {
  const text = OCR.replace(
    "****************9WO7",
    "****************9WO7\nOTHERACCOUNT1111",
  );
  includes(
    verify(text).flags,
    "RECEIVER_ACCOUNT_UNREADABLE",
    "multiple different recipient accounts remain review",
  );
});

Deno.test("GoTyme logo's narrow InstaFay OCR spelling retains all other verification checks", () => {
  const text = OCR.replace("InstaPay Instant", "instaFay Instant");
  equal(verify(text).flags, [], "known stylized logo OCR spelling");
  includes(
    verify(text.replace("Transferred", "Transfer pending")).flags,
    "TRANSFER_STATUS_UNREADABLE",
    "logo spelling never replaces successful status",
  );
});

Deno.test("GoTyme full merchant account remains separate from mobile identity", () => {
  const text = OCR.replace(
    "****************9WO7",
    "Acct No.: TESTMERCHANT9WO7",
  );
  equal(verify(text).recipientComparison.account, "exact", "exact QR account");
  equal(verify(text).flags, [], "full merchant recipient");
  includes(
    verify(
      text.replace("Acct No.: TESTMERCHANT9WO7", "Acct No.: OTHERACCOUNT9WO7"),
    ).flags,
    "RECEIVER_ACCOUNT_MISMATCH",
    "full IDs must match, not only suffix",
  );
});

Deno.test("GoTyme recipient evidence never comes from From or a later reference", () => {
  const missingTo = OCR.replace(
    "To KR****E L** C*\n****************9WO7\nG-Xchange, Inc (GCash)",
    "To",
  )
    .replace(
      "From SHEEJAN E*****",
      "From KR****E L** C*\nTESTMERCHANT9WO7\n09609422169\nGCash",
    );
  const parsed = parseGotymeToGcashReceipt(missingTo);
  equal(parsed.recipient.nameRaw, null, "no sender name borrowing");
  equal(parsed.recipient.phoneNormalized, null, "no sender phone borrowing");
  equal(
    parsed.recipient.accountNormalized,
    null,
    "no sender account borrowing",
  );
  equal(
    parsed.indicators.destinationGcash,
    false,
    "sender's bank is not destination",
  );
  includes(
    verify(missingTo).flags,
    "NUMBER_UNREADABLE",
    "missing recipient stays in review",
  );
  const noAnchor = OCR.replace("To KR****E L** C*", "KR****E L** C*");
  equal(
    parseGotymeToGcashReceipt(noAnchor).recipient.accountSuffix,
    null,
    "requires destination label",
  );
});

Deno.test("GoTyme explicit phone mismatch cannot be overridden by matching merchant account", () => {
  const text = OCR.replace(
    "****************9WO7",
    "****************9WO7\nMobile number 09981234567",
  );
  includes(
    verify(text).flags,
    "WRONG_GCASH_NUMBER",
    "conflicting phone evidence",
  );
});

Deno.test("GoTyme trace or typed reference cannot replace missing OCR primary reference", () => {
  const noReference = OCR.replace(
    "Reference No. ITO260909055941016",
    "Reference No.",
  );
  const parsed = parseGotymeToGcashReceipt(noReference, {
    typedReference: "ITO260909055941016",
  });
  equal(parsed.reference.value, null, "do not consume next Date label");
  includes(
    verifyGotymeToGcashReceipt(parsed, CONTEXT).flags,
    "REF_UNREADABLE",
    "OCR reference is required",
  );
  includes(
    verify(OCR.replace("Trace ID 941016", "Trace ID")).flags,
    "INSTAPAY_REF_UNREADABLE",
    "do not borrow following primary reference",
  );
  const mismatch = parseGotymeToGcashReceipt(OCR, { typedReference: "941016" });
  includes(
    verifyGotymeToGcashReceipt(mismatch, CONTEXT).flags,
    "REF_MISMATCH",
    "trace cannot be typed as primary reference",
  );
});

Deno.test("GoTyme wrong amount, date, stale time, and unsuccessful status remain in review", () => {
  includes(
    verify(OCR, { ...CONTEXT, expectedAmount: 530 }).flags,
    "AMOUNT_MISMATCH",
    "wrong amount",
  );
  includes(
    verify(OCR.replace("09 Sep 2026", "08 Sep 2026")).flags,
    "DATE_NOT_TODAY",
    "wrong date",
  );
  includes(
    verify(OCR.replace("1:59 PM", "2:59 PM")).flags,
    "TIME_EXPIRED",
    "outside booking payment window",
  );
  includes(
    verify(OCR.replace("09 Sep 2026", "31 Sep 2026")).flags,
    "DATE_UNREADABLE",
    "invalid calendar date",
  );
  includes(
    verify(OCR.replace("Transferred", "Transfer pending")).flags,
    "TRANSFER_STATUS_UNREADABLE",
    "pending status",
  );
  includes(
    verify(`${OCR}\nTransfer failed`).flags,
    "TRANSFER_STATUS_UNREADABLE",
    "conflicting failure status",
  );
});

Deno.test("GoTyme shuffled raw OCR without geometric rows must not guess recipient or reference associations", () => {
  const raw =
    `1:59\n91\ninstaFay\nTo\nFrom\nTransferred\nP265.00\nShare\nInstant\nKR****E L** C*\n****9W07\nG-Xchange, Inc (GCash)\nSHEEJAN E*****\n********4162\nGoTyme Bank\nAmount\nP265.00\nFee\nP0.00\nTotal\nTrace ID\nReference No.\nDate\nP265.00\n941016\nITO260909055941016\n09 Sep 2026 at 1:59 PM`;
  const parsed = parseGotymeToGcashReceipt(raw);
  equal(
    parsed.recipient.accountSuffix,
    null,
    "unassociated recipient requires spatial OCR",
  );
  equal(
    parsed.reference.value,
    null,
    "unassociated reference requires spatial OCR",
  );
  includes(verify(raw).flags, "REF_UNREADABLE", "shuffled OCR remains review");
});
