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

Deno.test('GCash native row layout reads real mask without confusing Bank Transfer heading',()=>{
 const rows=`Bank Transfer
Bank Transfer Complete
Sent via GCash
Bank MariBank
Account No. .......7144
Account Name KRISTIE LOU V.
Transfer Method Instapay
Receipt sent to test@example.invalid
Transfer Amount 795.00
+Fee 10.00
Total + 805.00
Date Oct 06, 2026 04:20 PM
InstaPay Invoice No. 1234567
Ref No. 1234567890123`;
 eq(flags(rows),[]);
 assert(flags(rows.replace('.......7144','.......9999')).length>0);
 assert(flags(rows.replace('.......7144','7144')).includes('RECEIVER_ACCOUNT_UNREADABLE'));
 assert(flags(rows+'\nAccount No. .......9999').length>0);
 assert(flags(rows.replace('Complete','Pending')).length>0);
 const parsed=parseProviderReceipt('maribank_direct',rows);if(parsed.provider!=='maribank_direct')throw Error();
 const read=bankFixtureRead(rows);const fallback={...read,nativeLines:undefined,nativeWordLines:read.nativeLines};
 assert(maribankDirectApprovalConfidence(fallback,parsed).confidence>=.9);
 const weak=structuredClone(fallback);const word=weak.nativeWordLines!.flatMap(l=>l.words).find(w=>w.text.includes('1234567890123'))!;word.confidence=.4;word.symbols.forEach(s=>s.confidence=.4);
 assert(maribankDirectApprovalConfidence(weak,parsed).confidence<.9);
 const logoRead=bankFixtureRead(rows+'\nPowered by InstaPay');
 const logo=logoRead.nativeLines!.at(-1)!.words.at(-1)!;
 logo.confidence=.3;logo.symbols.forEach(s=>s.confidence=.3);
 assert(maribankDirectApprovalConfidence(logoRead,parsed).confidence>=.9,'low decorative logo must not replace labeled rail confidence');
 const method=logoRead.nativeLines!.find(line=>line.text.startsWith('Transfer Method'))!.words.at(-1)!;
 method.confidence=.3;method.symbols.forEach(s=>s.confidence=.3);
 assert(maribankDirectApprovalConfidence(logoRead,parsed).confidence<.9,'weak labeled rail cannot borrow confidence from another occurrence');
});
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
Deno.test("native profile icon OCR preserves recipient identity and confidence checks", () => {
  const text = native.replace("Kristie Lou V.", "• Kristie Lou V.").replace(
    "MariBank\nAcct.",
    "M MariBank\nAcct.",
  );
  eq(flags(text), []);
  const parsed = parseProviderReceipt("maribank_direct", text);
  if (parsed.provider !== "maribank_direct") throw Error();
  eq(parsed.receipt.recipient.nameRaw, "• Kristie Lou V.");
  const read = bankFixtureRead(text);
  for (const word of read.nativeLines!.flatMap((line) => line.words)) {
    if (word.text === "•" || word.text === "M") word.confidence = .2;
  }
  eq(maribankDirectApprovalConfidence(read, parsed).confidence, .97);
  eq(
    maribankDirectApprovalConfidence(bankFixtureRead(text), parsed).confidence,
    .97,
  );
  assert(
    flags(text.replace("• Kristie Lou V.", "• Another Person")).includes(
      "RECEIVER_NAME_MISMATCH",
    ),
  );
  assert(
    flags(text.replace("15521507144", "11111111111")).includes(
      "RECEIVER_ACCOUNT_MISMATCH",
    ),
  );
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
      [gcash.replace("15521507144", "xxxx144"), "MARIBANK_AMBIGUOUS_FIELDS"],
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

Deno.test("GCash October column layouts, capitalization and tight dates preserve native values", () => {
  const variants = [
    gcash.replace("InstaPay\n", "Instapay\n").replace(
      "Oct 06, 2026",
      "Oct 06,2026",
    ),
    gcash.replace("15521507144", ".......7144\n⚫7144").replace(
      "InstaPay\n",
      "Instapay\n",
    ),
    gcash.replace(
      "MariBank\nAccount No.\nAccount Name\nTransfer Method\nReceipt sent to\n15521507144\nKRISTIE LOU VILLANUEVA\nInstaPay\ntest@example.invalid\nTransfer Amount\n+Fee\nTotal\nDate\nInstaPay Invoice No.\nRef No.",
      "Account No.\nAccount Name\nTransfer Method\nReceipt sent to\nTransfer Amount\n+Fee\nTotal\nDate\nInstaPay Invoice No.\nRef No.\nMariBank\n15521507144\nKRISTIE LOU VILLANUEVA\nInstaPay\ntest@example.invalid",
    ),
    gcash.replace("P 805.00", "+ 805.00"),
  ];
  for (const text of variants) {
    eq(flags(text), []);
    const p = parseProviderReceipt("maribank_direct", text);
    if (p.provider !== "maribank_direct") throw Error();
    const score = maribankDirectApprovalConfidence(bankFixtureRead(text), p);
    eq(score.confidence, .97);
  }
});
Deno.test("conflicting repeated accounts, missing labels, extra payment fields and short suffixes remain blocked", () => {
  for (
    const text of [
      gcash.replace("15521507144", ".......7144\n⚫9999"),
      gcash.replace("Account Name\n", ""),
      gcash + "\nRef No.\n9999999999999",
      gcash.replace("15521507144", "7144"),
      gcash.replace("P 805.00", "+ 905.00"),
    ]
  ) assert(flags(text).length > 0);
});
Deno.test("weak peso glyph may be ignored only with complete strong native total digits", () => {
  const text = gcash.replace("P 805.00", "P805.00");
  const parsed = parseProviderReceipt("maribank_direct", text);
  if (parsed.provider !== "maribank_direct") throw Error();
  const read = bankFixtureRead(text);
  const word = read.nativeLines!.flatMap((l) => l.words).find((w) =>
    w.text === "P805.00"
  )!;
  word.confidence = .4;
  word.symbols[0].confidence = .4;
  eq(maribankDirectApprovalConfidence(read, parsed).confidence, .97);
  word.symbols[2].confidence = .4;
  assert(maribankDirectApprovalConfidence(read, parsed).confidence < .9);
  word.symbols.splice(2, 1);
  assert(maribankDirectApprovalConfidence(read, parsed).confidence < .9);
});
Deno.test("detached native date column binds to the reference, never to status-bar time", () => {
  const text = native.replace(
    "Reference Number\n",
    "Reference Number\nTransaction Date & Time\n",
  ).replace(
    "BC550000000000000001\nTransaction Date & Time\n",
    "BC550000000000000001\n",
  );
  eq(flags(text), []);
  assert(
    flags(text.replace("06 Oct 2026, 16:20", "")).includes("TIME_UNREADABLE"),
  );
  const generated =
    text.replace("Transfer Result", "Transaction Receipt").replace(
      "Transfer Successful!",
      "",
    ) + "\nReceipt generated from MariBank app";
  assert(flags(generated).includes("TRANSFER_STATUS_UNREADABLE"));
});

Deno.test('October displaced timestamp and inline reference preserve native details', () => {
  const displaced = native.replace('Transaction Date & Time\n06 Oct 2026, 16:20','').replace('Reference Number\n','Reference Number\nTransaction Date & Time\n') + '\n06 Oct 2026, 16:20';
  eq(flags(displaced), []);
  const inline = native.replace('Reference Number\n','').replace('BC550000000000000001','Reference Number BC550000000000000001');
  eq(flags(inline), []);
  assert(flags(displaced+'\n07 Oct 2026, 16:20').includes('MARIBANK_TIMESTAMP_AMBIGUOUS'));
});
Deno.test('GCash decorative checkmark does not erase the table; bare suffix stays manual', () => {
  eq(flags(gcash.replace('MariBank\n','☑\nMariBank\n')), []);
  const bare = parseMaribankDirectReceipt(gcash.replace('15521507144','7144'));
  eq(bare.amount.amount, 795); eq(bare.reference.value,'1234567890123');
  assert(verifyMaribankDirectReceipt(bare,context).flags.includes('RECEIVER_ACCOUNT_UNREADABLE'));
  assert(flags(native+'\nYou will be notified once this\ntransaction is successful.').includes('TRANSFER_PENDING'));
});

Deno.test('native merged rows and Greek To label preserve recipient and financial checks', () => {
  const rows = `Transfer Result
Transfer Successful!
PHP 795.00
From SAMPLE SENDER
MariBank: 11111111111
◆ Kristie Lou V.
Το
MariBank
Acct. No.: 15521507144
Transfer Amount PHP 795.00
Transfer Fee FREE
Total Amount PHP 795.00
Reference Number BC550000000000000001
Transaction Date & Time 06 Oct 2026, 16:20`;
  eq(flags(rows), []);
  assert(flags(rows.replace('15521507144', '15521509999')).includes('RECEIVER_ACCOUNT_MISMATCH'));
  assert(flags(rows.replace('Total Amount PHP 795.00', 'Total Amount PHP 800.00')).includes('MARIBANK_TOTAL_MISMATCH'));
  assert(flags(rows.replace('Transaction Date & Time 06 Oct 2026, 16:20', '')).includes('TIME_UNREADABLE'));
  assert(flags(rows + '\nTo').includes('MARIBANK_RECIPIENT_SECTION_UNREADABLE'));
});

Deno.test('Unicode ellipsis masks do not hide weak visible account digits', () => {
  const text = gcash.replace('15521507144', '……………… 7144');
  const parsed = parseProviderReceipt('maribank_direct', text);
  if (parsed.provider !== 'maribank_direct') throw Error('provider');
  const read = bankFixtureRead(text);
  const words = read.nativeLines!.flatMap(line => line.words);
  const mask = words.find(word => word.text.includes('…'))!;
  mask.confidence = .12;
  mask.symbols.forEach(symbol => symbol.confidence = .12);
  assert(maribankDirectApprovalConfidence(read, parsed).confidence >= .9);
  const suffix = words.find(word => word.text === '7144')!;
  suffix.confidence = .5;
  suffix.symbols[0].confidence = .5;
  assert(maribankDirectApprovalConfidence(read, parsed).confidence < .9);
});

Deno.test('native surname initial uses its observed letter confidence without promoting a weak or missing letter', () => {
  const parsed=parseProviderReceipt('maribank_direct',native);
  if(parsed.provider!=='maribank_direct')throw Error('parser');
  const read=bankFixtureRead(native);
  const initial=read.nativeLines!.flatMap(l=>l.words).find(w=>w.text==='V.')!;
  initial.confidence=.85;
  initial.symbols=[{text:'V',confidence:.96},{text:'.',confidence:.74}];
  eq(maribankDirectApprovalConfidence(read,parsed).fields.recipientName.confidence,.96);
  initial.symbols[0].confidence=.7;
  eq(maribankDirectApprovalConfidence(read,parsed).fields.recipientName.confidence,.7);
  initial.symbols=[{text:'.',confidence:.99}];
  assert(maribankDirectApprovalConfidence(read,parsed).confidence<.9,'missing observed initial cannot be synthesized');
  initial.symbols=[{text:'X',confidence:.99},{text:'.',confidence:.99}];
  assert(maribankDirectApprovalConfidence(read,parsed).confidence<.9,'different observed letter cannot receive credit');
});
