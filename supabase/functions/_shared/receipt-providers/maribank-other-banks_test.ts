import {
  parseProviderReceipt,
  type ReceiptVerificationContext,
  verifyProviderReceipt,
} from "./index.ts";
import { maribankDirectApprovalConfidence, bankLayoutFamily } from "../bank-ocr-evidence.ts";
import { bankFixtureRead } from "../bank-ocr-fixtures.ts";

function eq(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m} ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}
function assert(a: unknown, m = "assertion") {
  if (!a) throw new Error(m);
}
const base = {
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientName: "KRISTIE LOU VILLANUEVA",
  expectedRecipientNumber: "15521507144",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};
const check = (text: string, context: ReceiptVerificationContext) => {
  const p = parseProviderReceipt("maribank_direct", text);
  if (p.provider !== "maribank_direct") throw Error("wrong parser");
  return { p, flags: verifyProviderReceipt(p, context).flags };
};

// Layout of a real UnionBank Online receipt (2026-11-12); sender replaced.
const unionbank = `Reference Number:
UB1022185
Status
Successful
Nov 12, 2026 | 08:41 PM
Sent Via
instaPay
Instapay Reference Number
520720
To
KRISTIE LOU V.
Maribank
1552 1507 144
Amount
PHP 265.00
From
SAMPLE SENDER
NAME
Premier Plus Savings ePaycard
**** **** 0000
Thank you for using UnionBank Online`;
const ubContext: ReceiptVerificationContext = {
  ...base,
  expectedAmount: 265,
  bookingStartedAt: "2026-11-12T12:39:36Z",
  bookingStartedDate: "2026-11-12",
};

// Two real layouts of the "Your transaction has been processed." app
// (2026-11-14, 2026-11-15): label/value rows and label/value columns.
const mbRows = `6:41
4G
Your transaction has been
processed.
You may check the latest status of your
transaction in Fund Transfer > Transaction History.
Transaction Reference Number
MBAAA26111518405850228718
Transaction Details
InstaPay
0003007645537
Reference No.
Transaction Type
Fund Transfer via
InstaPay
Transaction Date
November 15, 2026
Source Account
6:40:51 PM
1234567890
Savings Account
Destination
KRISTIE LOU V.
Account
MariBank Philippines Inc
15521507144
Amount
PHP 530.00
Transfer Channel
instaFay
Purpose
Payment
Service Charge
|||
U
DUD 0`;
const mbColumns = `18:00
Your transaction has been processed.
You may check the latest status of your transaction
in Fund Transfer > Transaction History.
Transaction Reference Number
MBAEE26111418003439693842
Transaction Details
InstaPay
0003006821894
Reference No.
Transaction Type
Fund Transfer
via InstaPay
Transaction Date
November 14, 2026
6:00:31 PM
Source Account
1234567890
Savings Account
Destination Account
Amount
Transfer Channel
Purpose
Service Charge
KRISTIE LOU V.
MariBank
Philippines Inc
15521507144
PHP 530.00
instaFay
Payment
PHP 0.00
Done`;
const mbRowsContext: ReceiptVerificationContext = {
  ...base,
  expectedAmount: 530,
  bookingStartedAt: "2026-11-15T10:39:04Z",
  bookingStartedDate: "2026-11-15",
};
const mbColumnsContext: ReceiptVerificationContext = {
  ...base,
  expectedAmount: 530,
  bookingStartedAt: "2026-11-14T09:59:18Z",
  bookingStartedDate: "2026-11-14",
};

Deno.test("UnionBank Online receipts to MariBank verify every detail", () => {
  const { p, flags } = check(unionbank, ubContext);
  eq(p.receipt.source, "unionbank");
  eq(p.receipt.reference.value, "UB1022185");
  eq(p.receipt.amount.amount, 265);
  eq(p.receipt.timestamp.instant, "2026-11-12T12:41:00.000Z");
  eq(p.receipt.recipient, { nameRaw: "KRISTIE LOU V.", accountRaw: "1552 1507 144", bankRaw: "Maribank" });
  eq(flags, []);
  eq(bankLayoutFamily("maribank_direct", unionbank), "unionbank_to_maribank_v1");
  const v = verifyProviderReceipt(p, ubContext);
  eq(v.dedupeKeys.map((k) => k.key), ["maribank:UB1022185", "unionbank_instapay:520720"]);
  const approval = maribankDirectApprovalConfidence(bankFixtureRead(unionbank), p);
  assert(approval.complete && approval.confidence >= .9, JSON.stringify(approval));
});

Deno.test("UnionBank receipts stay manual on any missing, conflicting or wrong detail", () => {
  const blocked = (text: string, why: string, context = ubContext) =>
    assert(check(text, context).flags.length > 0, `${why} approved`);
  blocked(unionbank.replace("PHP 265.00", "PHP 530.00"), "wrong amount");
  blocked(unionbank.replace("1552 1507 144", "1552 1507 145"), "wrong account");
  blocked(unionbank.replace("KRISTIE LOU V.", "GLORIA MARIS P."), "wrong name");
  blocked(unionbank.replace("Maribank", "BDO Unibank"), "wrong bank");
  blocked(unionbank.replace("Successful", "Pending"), "pending status");
  blocked(unionbank.replace("520720\n", ""), "missing InstaPay reference");
  blocked(unionbank.replace("Amount\nPHP 265.00\n", "Amount\nPHP 265.00\nPHP 10.00\n"), "extra amount");
  blocked(unionbank + "\nRequest Submitted\nNov 12, 2026 08:55 PM", "second time");
  blocked(unionbank.replace("08:41 PM", "09:41 PM"), "outside payment window");
  // Cropped by a pop-up before the account and amount (real 2026-11-11 case).
  blocked(unionbank.split("\nMaribank\n")[0] + "\nMaribank\nYour connection seems unstable\nX\nThank you for using UnionBank Online", "cropped");
  // A different UnionBank screen without the closing brand line is not this layout.
  const unbranded = parseProviderReceipt("maribank_direct", unionbank.replace("Thank you for using UnionBank Online", ""));
  assert(unbranded.provider === "maribank_direct" && unbranded.receipt.source !== "unionbank", "unbranded read as UnionBank");
});

Deno.test("processed fund-transfer receipts to MariBank verify in row and column layouts", () => {
  for (const [text, context, instant, ref] of [
    [mbRows, mbRowsContext, "2026-11-15T10:40:51.000Z", "MBAAA26111518405850228718"],
    [mbColumns, mbColumnsContext, "2026-11-14T10:00:31.000Z", "MBAEE26111418003439693842"],
  ] as const) {
    const { p, flags } = check(text, context);
    eq(p.receipt.source, "mb_fund_transfer");
    eq(p.receipt.reference.value, ref);
    eq(p.receipt.amount.amount, 530);
    eq(p.receipt.timestamp.instant, instant);
    eq(p.receipt.recipient.accountRaw, "15521507144");
    eq(flags, [], ref);
    eq(bankLayoutFamily("maribank_direct", text), "mb_fund_transfer_to_maribank_v1");
    const approval = maribankDirectApprovalConfidence(bankFixtureRead(text), p);
    assert(approval.complete && approval.confidence >= .9, JSON.stringify(approval));
  }
  eq(check(mbColumns, mbColumnsContext).p.receipt.transferFee, 0);
});

Deno.test("processed fund-transfer receipts stay manual on any conflict", () => {
  const blocked = (text: string, why: string, context = mbColumnsContext) =>
    assert(check(text, context).flags.length > 0, `${why} approved`);
  blocked(mbColumns.replace("6:00:31 PM", "6:20:31 PM"), "visible time disagrees with the reference");
  blocked(mbColumns.replace("November 14, 2026", "November 13, 2026"), "visible date disagrees with the reference");
  blocked(mbColumns.replace("PHP 530.00", "PHP 265.00"), "wrong amount");
  blocked(mbColumns.replace("PHP 0.00", "PHP 15.00"), "unexplained second amount");
  blocked(mbColumns.replace("15521507144", "15521507145"), "wrong account");
  blocked(mbColumns.replace("1234567890", "15500000000"), "second 11-digit account");
  blocked(mbColumns.replace("KRISTIE LOU V.", "GLORIA MARIS P."), "wrong name");
  blocked(mbColumns.replace("MariBank\nPhilippines Inc", "BPI\nPhilippines Inc"), "wrong bank");
  blocked(mbColumns.replace("Your transaction has been processed.", "Your transaction is being processed."), "not processed");
  blocked(mbColumns.replace("0003006821894\n", ""), "missing InstaPay reference");
  blocked(mbColumns + "\nJUAN DELA CRUZ", "second recipient name");
});

Deno.test("MB fund-transfer destination must be exactly MariBank Philippines Inc", () => {
  assert(check(mbRows.replace("MariBank Philippines Inc", "MariBank Philippines Inx"), mbRowsContext).flags.length > 0, "misread bank accepted");
});

// How Vision's layout reading actually returned the column receipt: labels
// and values on one line.
const mbMerged = `18:00 49
....
Your transaction has been processed.
You may check the latest status of your transaction
in Fund Transfer > Transaction History.
Transaction Reference Number
MBAEE26111418003439693842
Transaction Details
InstaPay 0003006821894
Reference No.
Transaction Type Fund Transfer
via InstaPay
Transaction Date November 14, 2026
6:00:31 PM
Source Account 1234567890
Savings Account
Destination Account KRISTIE LOU V.
MariBank
Philippines Inc
15521507144
Amount PHP 530.00
Transfer Channel instaFay
Purpose Payment
Service Charge PHP 0.00
Done`;

Deno.test("labels and values read on one line still verify, by each value's own type", () => {
  const { p, flags } = check(mbMerged, mbColumnsContext);
  eq(p.receipt.source, "mb_fund_transfer");
  eq(flags, []);
  eq(p.receipt.recipient.nameRaw, "KRISTIE LOU V.");
  eq(p.receipt.amount.amount, 530);
  const approval = maribankDirectApprovalConfidence(bankFixtureRead(mbMerged), p);
  assert(approval.complete && approval.confidence >= .9, JSON.stringify(approval));
  assert(check(mbMerged.replace("Amount PHP 530.00", "Amount PHP 265.00"), mbColumnsContext).flags.length > 0, "wrong amount");
  const ubMerged = unionbank.replace("To\nKRISTIE", "To KRISTIE").replace("Amount\nPHP", "Amount PHP")
    .replace("Sent Via\ninstaPay", "Sent Via instaPay");
  eq(check(ubMerged, ubContext).flags, []);
});

Deno.test("UnionBank date and time are scored without the separator bar", () => {
  const { p } = check(unionbank, ubContext);
  eq((p.receipt.paymentFields as Record<string, unknown>).dateTime, "Nov 12, 2026");
  eq((p.receipt.paymentFields as Record<string, unknown>).time, "08:41 PM");
});
