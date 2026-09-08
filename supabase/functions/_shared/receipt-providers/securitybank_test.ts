import {
  parseSecurityBankReceipt,
  verifySecurityBankReceipt,
} from "./securitybank.ts";
import {
  isDedicatedReceiptProvider,
  parseProviderReceipt,
  verifyProviderReceipt,
} from "./index.ts";
function assert(x: unknown, m = "Assertion failed"): asserts x {
  if (!x) throw Error(m);
}
const RECEIPT = `Bank Transfer Complete
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
Powered by instaPay`;
const context = {
  typedReference: "2044841788110",
  expectedAmount: 1,
  pricingAvailable: true,
  amountTolerance: 0.01,
  expectedRecipientNumber: "000012342980",
  expectedRecipientName: "KRISTIE LOU VALDEZ",
  bookingStartedAt: "2026-09-08T16:50:00Z",
  bookingStartedDate: "2026-09-09",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
  now: "2026-09-08T16:55:00Z",
};
const check = (text = RECEIPT, override: Partial<typeof context> = {}) => {
  const c = { ...context, ...override };
  return verifySecurityBankReceipt(
    parseSecurityBankReceipt(text, { typedReference: c.typedReference }),
    c,
  );
};
Deno.test("extracts destination, masked suffix, reference, invoice and transfer amount separately from fees", () => {
  const p = parseSecurityBankReceipt(RECEIPT, {
    typedReference: context.typedReference,
  });
  assert(p.amount.amount === 1, "Must not count 11 total as payment");
  assert(p.transferFee === 10);
  assert(p.total === 11);
  assert(p.reference.value === "2044841788110");
  assert(p.invoice.value === "428516");
  assert(p.recipient.accountRaw?.endsWith("2980"));
  assert(p.timestamp.instant === "2026-09-08T16:52:00.000Z");
  assert(check().flags.length === 0, JSON.stringify(check().flags));
});
Deno.test("actual supplied recipient name conflicts with the sample receipt and stays pending", () => {
  assert(
    check(RECEIPT, { expectedRecipientName: "KRISTIE LOU CACHUELA" }).flags
      .includes("RECEIVER_NAME_MISMATCH"),
  );
});
Deno.test("supports inline labelled values and case-insensitive names", () => {
  const inline = RECEIPT.replace(
    "Bank\nSecurity Bank\nCorporation",
    "Bank: Security Bank Corporation",
  ).replace("Account No.\n", "Account No. ").replace(
    "Account Name\nKristie Lou V.",
    "Account Name Kristie Lou Valdez",
  ).replace("Transfer Method\n", "Transfer Method ").replace(
    "Transfer Amount\n",
    "Transfer Amount ",
  ).replace("+Fee\n", "+Fee ").replace("Total\n", "Total ").replace(
    "Date\n",
    "Date ",
  ).replace("InstaPay Invoice No.\n", "InstaPay Invoice No. ").replace(
    "Ref No.\n",
    "Ref No. ",
  );
  assert(check(inline).flags.length === 0, JSON.stringify(check(inline).flags));
});
for (
  const [name, text, flag] of [
    [
      "wrong bank",
      RECEIPT.replace("Security Bank\nCorporation", "Other Bank"),
      "SECURITYBANK_DESTINATION_MISMATCH",
    ],
    [
      "wrong account",
      RECEIPT.replace("2980", "2981"),
      "RECEIVER_ACCOUNT_MISMATCH",
    ],
    [
      "wrong name",
      RECEIPT.replace("Kristie Lou V.", "Other Person V."),
      "RECEIVER_NAME_MISMATCH",
    ],
    [
      "missing account",
      RECEIPT.replace("Account No.\n••••••••2980\n", ""),
      "RECEIVER_ACCOUNT_UNREADABLE",
    ],
    [
      "missing name",
      RECEIPT.replace("Account Name\nKristie Lou V.\n", ""),
      "RECEIVER_NAME_UNREADABLE",
    ],
    [
      "missing amount",
      RECEIPT.replace("Transfer Amount\n1.00\n", ""),
      "AMOUNT_UNREADABLE",
    ],
    [
      "missing fee",
      RECEIPT.replace("+Fee\n10.00\n", ""),
      "SECURITYBANK_AMOUNT_BREAKDOWN_UNREADABLE",
    ],
    [
      "wrong total",
      RECEIPT.replace("₱ 11.00", "₱ 99.00"),
      "SECURITYBANK_TOTAL_MISMATCH",
    ],
    [
      "ambiguous amount",
      RECEIPT.replace(
        "Transfer Amount\n1.00",
        "Transfer Amount\n1.00\nTransfer Amount\n2.00",
      ),
      "SECURITYBANK_AMBIGUOUS_FIELDS",
    ],
    [
      "missing reference",
      RECEIPT.replace("Ref No.\n2044841788110\n", ""),
      "REF_UNREADABLE",
    ],
    [
      "wrong reference",
      RECEIPT.replace("2044841788110", "2044841788111"),
      "REF_MISMATCH",
    ],
    [
      "missing invoice",
      RECEIPT.replace("InstaPay Invoice No.\n428516\n", ""),
      "SECURITYBANK_INVOICE_UNREADABLE",
    ],
    [
      "missing date",
      RECEIPT.replace("Date\nSep 09, 2026 12:52 AM\n", ""),
      "TIME_UNREADABLE",
    ],
    ["impossible date", RECEIPT.replace("Sep 09", "Sep 31"), "TIME_UNREADABLE"],
    ["old receipt", RECEIPT.replace("Sep 09", "Sep 08"), "DATE_NOT_TODAY"],
    ["expired receipt", RECEIPT.replace("12:52 AM", "1:52 AM"), "TIME_EXPIRED"],
    ["future receipt", RECEIPT.replace("12:52 AM", "12:59 AM"), "TIME_FUTURE"],
    [
      "unsuccessful",
      RECEIPT.replace("Bank Transfer Complete", "Bank Transfer Pending"),
      "TRANSFER_STATUS_UNREADABLE",
    ],
    [
      "wrong source",
      RECEIPT.replace("Sent via GCash", "Sent via Other Bank"),
      "SECURITYBANK_SOURCE_UNREADABLE",
    ],
    [
      "wrong rail",
      RECEIPT.replace("Transfer Method\nInstaPay", "Transfer Method\nPESONet"),
      "INSTAPAY_QRPH_UNREADABLE",
    ],
  ] as const
) {
  Deno.test(name + " requires owner review", () =>
    assert(
      check(text).flags.includes(flag),
      JSON.stringify(check(text).flags),
    ));
}
Deno.test("fee-inclusive total does not satisfy amount owed", () =>
  assert(
    check(RECEIPT, { expectedAmount: 11 }).flags.includes("AMOUNT_MISMATCH"),
  ));
Deno.test("underpayment and overpayment require review", () => {
  assert(
    check(RECEIPT, { expectedAmount: 315 }).flags.includes("AMOUNT_MISMATCH"),
  );
  assert(
    check(RECEIPT, { expectedAmount: 0.99 }).flags.includes("AMOUNT_MISMATCH"),
  );
});
Deno.test("requires configured full account and name", () => {
  for (
    const override of [{ expectedRecipientName: "" }, {
      expectedRecipientNumber: "",
    }, { expectedRecipientNumber: "2980" }]
  ) assert(check(RECEIPT, override).flags.includes("MERCHANT_CONFIG_MISSING"));
});
Deno.test("full account must match entirely, not only last four digits", () =>
  assert(
    check(RECEIPT.replace("••••••••2980", "999912342980")).flags.includes(
      "RECEIVER_ACCOUNT_MISMATCH",
    ),
  ));
Deno.test("reference is extracted without using the customer input as OCR evidence", () => {
  const parsed = parseSecurityBankReceipt(RECEIPT, {
    typedReference: "9999999999999",
  });
  assert(parsed.reference.value === "2044841788110");
  assert(parsed.reference.typedMatch === "mismatch");
});
Deno.test("deduplication includes bank reference, shared GCash reference and invoice", () => {
  const keys = check().dedupeKeys.map((x) => x.key);
  assert(keys.includes("securitybank:2044841788110"));
  assert(keys.includes("2044841788110"));
  assert(keys.includes("gcash_instapay_invoice:428516"));
});
Deno.test("receipt email is not recipient identity and can differ", () =>
  assert(
    check(RECEIPT.replace("sample@example.com", "another@example.com")).flags
      .length === 0,
  ));
Deno.test("provider registry routes Security Bank through its own verifier", () => {
  assert(isDedicatedReceiptProvider("securitybank"));
  const parsed = parseProviderReceipt("securitybank", RECEIPT, {
    typedReference: context.typedReference,
  });
  assert(parsed.parserVersion === "gcash_to_securitybank_v1");
  const result = verifyProviderReceipt(parsed, context);
  assert(result.destinationProvider === "securitybank");
  assert(result.flags.length === 0, JSON.stringify(result.flags));
});

Deno.test("Security Bank receipt-only checkout extracts its own reference without a typed value", () => {
  const parsed = parseSecurityBankReceipt(RECEIPT);
  assert(parsed.reference.typedMatch === "not_provided");
  assert(parsed.reference.value === context.typedReference);
  assert(check(RECEIPT, { typedReference: "" }).flags.length === 0);
  assert(check(RECEIPT.replace("2044841788110", "unreadable"), { typedReference: "" }).flags.includes("REF_UNREADABLE"));
  assert(check(RECEIPT, { typedReference: "9999999999999" }).flags.includes("REF_MISMATCH"));
});

// Redacted real Vision output: label columns precede value columns.
const COLUMN_RECEIPT = "Bank Transfer Complete\nSent via GCash\nSuccessful transactions are credited instantly. You will receive\nan update about this transaction in your GCash Inbox.\nBank\nAccount No.\nAccount Name\nTransfer Method\nSecurity Bank\nCorporation\n.........2980\nKristie Lou V.\nInstaPay\nReceipt sent to\nsample@example.com\nTransfer Amount\n1.00\n+Fee\nTotal\n10.00\nP 11.00\nDate\nSep 09, 2026 02:16 AM\nInstaPay Invoice No.\n911062\nRef No.\n2044842501303\n228g (gC02e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.\nPowered by instaFay";
Deno.test('real Vision column layout reads independent transfer, fee, total and recipient', () => {
 const p = parseSecurityBankReceipt(COLUMN_RECEIPT);
 assert(p.reference.value === '2044842501303');
 assert(p.invoice.value === '911062');
 assert(p.amount.amount === 1 && p.transferFee === 10 && p.total === 11);
 assert(p.recipient.bankRaw === 'Security Bank Corporation');
 assert(p.recipient.nameRaw === 'Kristie Lou V.');
 assert(p.recipient.accountRaw?.endsWith('2980'));
 assert(p.timestamp.instant === '2026-09-08T18:16:00.000Z');
 const v = verifySecurityBankReceipt(p, {...context, typedReference:'', expectedRecipientName:'KRISTIE LOU V.', bookingStartedAt:'2026-09-08T18:14:27Z', now:'2026-09-08T18:19:00Z'});
 assert(v.flags.length === 0, JSON.stringify(v.flags));
 const masked = verifySecurityBankReceipt(p, {...context, typedReference:'', expectedRecipientNumber:'*********2980', bookingStartedAt:'2026-09-08T18:14:27Z', now:'2026-09-08T18:19:00Z'});
 assert(masked.flags.includes('MERCHANT_CONFIG_MISSING'));
});
Deno.test('incomplete, reordered, duplicated and conflicting column evidence stays for review', () => {
 for (const raw of [
  COLUMN_RECEIPT.replace('Kristie Lou V.\n',''),
  COLUMN_RECEIPT.replace('Account No.\nAccount Name','Account Name\nAccount No.'),
  COLUMN_RECEIPT.replace('Security Bank\nCorporation','Other Bank\nCorporation'),
  COLUMN_RECEIPT.replace('+Fee\nTotal\n10.00\nP 11.00','+Fee\nTotal\nP 11.00\n10.00'),
  COLUMN_RECEIPT + '\nBank: Security Bank Corporation',
  COLUMN_RECEIPT + '\nAccount No.: ********1234',
  COLUMN_RECEIPT + '\nTotal: P 11.00',
 ]) {
  const v=verifySecurityBankReceipt(parseSecurityBankReceipt(raw), {...context, typedReference:'', bookingStartedAt:'2026-09-08T18:14:27Z', now:'2026-09-08T18:19:00Z'});
  assert(v.flags.length > 0, 'Uncertain column layout must not pass');
 }
});
