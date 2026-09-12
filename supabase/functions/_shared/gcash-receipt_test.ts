import {
  compareGcashMaskedName,
  compareGcashRecipient,
  isGcashRecipientAccepted,
  normalizeGcashMobile,
  parseGcashReceipt,
  recoverGcashReferenceText,
  recoverGcashTimestampText,
} from "./gcash-receipt.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const USER_GCASH_OCR = `
J•• KE••••H M.
+63 998 123 4567
Sent via GCash
Amount
12.00
Total Amount Sent
₱12.00
Ref No. 2043350406766 Jul 28, 2026 10:41 AM
279g (gCO2e)
By going digital, you reduce your carbon footprint.
`;

const EXPECTED_RECIPIENT = {
  phone: "09981234567",
  name: "Jan Kennith Magallano",
};

// Anonymized saved Vision output: detached Amount, split total, joined date.
const SPLIT_TOTAL_JOINED_DATE = `Amount
J•• KE••••H M.
+63 998 123 4567
Sent via GCash
530.00
Total Amount Sent
P 530.00
Ref No. 2043 350 406766Sep 10, 2026 3:48 PM
279g (CO2e)`;

Deno.test("split total and reference-adjacent date retain independent receipt evidence", () => {
  const parsed = parseGcashReceipt(SPLIT_TOTAL_JOINED_DATE);
  assertEquals(parsed.reference.value, "2043350406766", "reference unchanged");
  assertEquals(parsed.timestamp.date, "2026-09-10", "joined date");
  assertEquals(parsed.timestamp.time24, "15:48", "receipt time");
  assertEquals(parsed.timestamp.instant, "2026-09-10T07:48:00.000Z", "Philippine timezone");
  assertEquals(parsed.timestamp.lineIndex, 7, "original OCR line");
  assertEquals(parsed.amount.amount, 530, "amount");
  assertEquals(parsed.amount.matchingPrimaryAmountDisplays, true, "two displays");
  assertEquals(parsed.amount.conflictingPrimaryAmounts, false, "consistent displays");
});

Deno.test("split total recovery preserves mismatches and requires bounded currency evidence", () => {
  const conflicting = parseGcashReceipt(SPLIT_TOTAL_JOINED_DATE.replace("\n530.00\n", "\n520.00\n"));
  assertEquals(conflicting.amount.conflictingPrimaryAmounts, true, "mismatch retained");
  assertEquals(conflicting.amount.matchingPrimaryAmountDisplays, false, "no agreement");
  for (const text of [
    SPLIT_TOTAL_JOINED_DATE.replace("P 530.00", "Fee\nP 530.00"),
    SPLIT_TOTAL_JOINED_DATE.replace("P 530.00", "P 530.00\nAdvertisement"),
    SPLIT_TOTAL_JOINED_DATE.replace("P 530.00", "530.00"),
  ]) {
    assertEquals(parseGcashReceipt(text).amount.matchingPrimaryAmountDisplays, false, "do not infer confirmation");
  }
  assertEquals(parseGcashReceipt(SPLIT_TOTAL_JOINED_DATE.replace("Sep 10", "Sep 31")).timestamp.completeness, "invalid", "invalid date retained");
});

// Anonymized production Vision ordering: left-column Ref precedes amounts.
const REFERENCE_FIRST_OCR = `11:23 1
Amount
Express Send
J•• KE••••H M.
+63 998 123 4567
Sent via GCash
Total Amount Sent
Ref No. 2043350406766
-51%
81
265.00
P265.00
Sep 9, 2026 11:23 AM
From Metro Manila In Stock
Shopee
P999.00
279g (gCO2e)`;

Deno.test("GCash reads concordant amounts after Ref in production Vision ordering", () => {
  const parsed = parseGcashReceipt(REFERENCE_FIRST_OCR);
  assertEquals(parsed.amount.amount, 265, "receipt amount, not advertisement");
  assertEquals(parsed.amount.reliable, true, "reliable amount");
  assertEquals(
    parsed.amount.matchingPrimaryAmountDisplays,
    true,
    "two displays",
  );
  assertEquals(parsed.amount.conflictingPrimaryAmounts, false, "no conflict");
});

Deno.test("GCash reference-first recovery fails closed on incomplete or conflicting evidence", () => {
  for (
    const text of [
      REFERENCE_FIRST_OCR.replace("P265.00", "P365.00"),
      REFERENCE_FIRST_OCR.replace("265.00\n", ""),
      REFERENCE_FIRST_OCR.replace("P265.00", "265.00"),
      REFERENCE_FIRST_OCR.replace("Sep 9, 2026 11:23 AM", ""),
      REFERENCE_FIRST_OCR.replace(
        "265.00\nP265.00",
        "Advertisement\n265.00\nP265.00",
      ),
      REFERENCE_FIRST_OCR.replace(
        "265.00\nP265.00",
        "Transfer Fee\n265.00\nP265.00",
      ),
      REFERENCE_FIRST_OCR.replace("P265.00", "P265.00\nP265.00"),
    ]
  ) {
    const parsed = parseGcashReceipt(text);
    assertEquals(
      parsed.amount.reliable && parsed.amount.matchingPrimaryAmountDisplays &&
        !parsed.amount.conflictingPrimaryAmounts,
      false,
      text,
    );
  }
});

Deno.test("parses the supplied masked-name GCash receipt", () => {
  const parsed = parseGcashReceipt(USER_GCASH_OCR, {
    typedReference: "2043350406766",
  });

  assertEquals(parsed.provider, "gcash", "provider");
  assertEquals(parsed.reference.value, "2043350406766", "reference");
  assertEquals(parsed.reference.source, "ref_label", "reference source");
  assertEquals(parsed.reference.typedMatch, "match", "typed reference");
  assertEquals(parsed.amount.amount, 12, "amount");
  assertEquals(parsed.amount.reliable, true, "amount reliability");
  assertEquals(parsed.amount.ambiguous, false, "amount ambiguity");
  assertEquals(
    parsed.amount.conflictingPrimaryAmounts,
    false,
    "amount consistency",
  );
  assertEquals(
    parsed.amount.matchingPrimaryAmountDisplays,
    true,
    "amount display confirmation",
  );
  assertEquals(parsed.timestamp.date, "2026-07-28", "receipt date");
  assertEquals(parsed.timestamp.time24, "10:41", "receipt time");
  assertEquals(
    parsed.timestamp.instant,
    "2026-07-28T02:41:00.000Z",
    "PH instant",
  );
  assertEquals(parsed.timestamp.completeness, "date_time", "timestamp");
  assertEquals(
    parsed.receiver.phone.raw,
    "+63 998 123 4567",
    "receiver phone raw",
  );
  assertEquals(
    parsed.receiver.phone.normalized,
    "9981234567",
    "receiver phone normalized",
  );
  assertEquals(parsed.receiver.phone.visibility, "full", "phone visibility");
  assertEquals(
    parsed.receiver.name.raw,
    "J•• KE••••H M.",
    "masked receiver name",
  );
  assertEquals(parsed.receiver.name.visibility, "masked", "name visibility");
  assertEquals(
    parsed.indicators.sentViaGcash,
    true,
    "sent-via-GCash indicator",
  );
  assertEquals(
    parsed.indicators.totalAmountSent,
    true,
    "total-amount indicator",
  );
  assertEquals(
    parsed.indicators.referenceLabel,
    true,
    "reference indicator",
  );
  assertEquals(
    parsed.indicators.classification,
    "gcash",
    "receipt classification",
  );

  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(comparison.phone, "exact", "receiver phone comparison");
  assertEquals(
    comparison.name,
    "masked_compatible",
    "masked receiver comparison",
  );
  assertEquals(
    comparison.nameSupportingOnly,
    true,
    "masked name is supporting only",
  );
  assert(
    !parsed.amount.candidates.some((candidate) => candidate.amount === 279),
    "carbon figure must never become an amount",
  );
});

Deno.test("matches bullet dot and collapsed GCash name masks", () => {
  for (
    const observed of [
      "J•• KE••••H M.",
      "J.. KE....H M.",
      "J• KE••H M.",
    ]
  ) {
    assertEquals(
      compareGcashMaskedName(observed, "Jan Kennith Magallano"),
      "masked_compatible",
      observed,
    );
  }
});

Deno.test("matches a fully visible receiver name exactly", () => {
  assertEquals(
    compareGcashMaskedName(
      "Jan Kennith Magallano",
      "Jan Kennith Magallano",
    ),
    "exact",
    "full receiver name",
  );
});

Deno.test("rejects visible contradictions in a masked receiver name", () => {
  assertEquals(
    compareGcashMaskedName("J•• KA••••H M.", "Jan Kennith Magallano"),
    "mismatch",
    "given-name anchor conflict",
  );
  assertEquals(
    compareGcashMaskedName("J•• KE••••H R.", "Jan Kennith Magallano"),
    "mismatch",
    "surname initial conflict",
  );
});

Deno.test("does not overstate a masked name with too few visible letters", () => {
  assertEquals(
    compareGcashMaskedName("J•• ••••••• M.", "Jan Kennith Magallano"),
    "inconclusive",
    "two visible initials",
  );
});

Deno.test("a wrong full receiver phone cannot be rescued by the name", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "+63 998 123 4567",
      "+63 945 510 9999",
    ),
  );
  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(comparison.phone, "mismatch", "wrong receiver phone");
  assertEquals(
    comparison.name,
    "masked_compatible",
    "name remains separate evidence",
  );
});

Deno.test("phone last four digits elsewhere cannot create a receiver match", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR
      .replace("+63 998 123 4567\n", "")
      .replace("2043350406766", "2043350404567"),
  );
  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(parsed.receiver.phone.visibility, "missing", "receiver phone");
  assertEquals(comparison.phone, "missing", "no global last-four match");
});

Deno.test("normalizes supported full Philippine mobile formats", () => {
  for (
    const value of [
      "0998 123 4567",
      "+63 998 123 4567",
      "998-123-4567",
    ]
  ) {
    assertEquals(
      normalizeGcashMobile(value),
      "9981234567",
      `normalize ${value}`,
    );
  }
  assertEquals(normalizeGcashMobile("945510766"), null, "short mobile");
  assertEquals(normalizeGcashMobile("99812345670"), null, "long mobile");
});

Deno.test("parses a masked receiver phone as last-four evidence only", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "+63 998 123 4567",
      "+63 9•• ••• 4567",
    ),
  );
  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(parsed.receiver.phone.visibility, "masked", "masked phone");
  assertEquals(parsed.receiver.phone.normalized, null, "no invented phone");
  assertEquals(parsed.receiver.phone.last4, "4567", "visible last four");
  assertEquals(comparison.phone, "last4_only", "partial phone comparison");
});

Deno.test("receiver phone digits are never parsed as the GCash reference", () => {
  const parsed = parseGcashReceipt(USER_GCASH_OCR);
  assertEquals(parsed.reference.value, "2043350406766", "labeled reference");
  assert(
    parsed.reference.value !== parsed.receiver.phone.normalized,
    "reference and phone must remain distinct",
  );
});

Deno.test("normalizes a spaced labeled GCash reference", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "Ref No. 2043350406766",
      "Ref No. 2043 3504 06766",
    ),
  );
  assertEquals(parsed.reference.value, "2043350406766", "spaced reference");
  assertEquals(parsed.reference.source, "ref_label", "spaced ref source");
});

Deno.test("joins a GCash reference wrapped below its label beside the date column", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "Ref No. 2043350406766",
      "Ref No. 1044 923 Sep 11, 2026 11:55\n718392 AM",
    ),
  );
  assertEquals(parsed.reference.value, "1044923718392", "wrapped reference");
  assertEquals(parsed.reference.source, "ref_label", "labelled reference source");
  assertEquals(parsed.reference.confidence, "high", "labelled reference confidence");
});

Deno.test("keeps OCR evidence independent from a mismatched typed reference", () => {
  const parsed = parseGcashReceipt(USER_GCASH_OCR, {
    typedReference: "2043350406767",
  });
  assertEquals(
    parsed.reference.value,
    "2043350406766",
    "OCR reference remains authoritative evidence",
  );
  assertEquals(parsed.reference.typedMatch, "mismatch", "typed mismatch");
});

Deno.test("marks a unique standalone reference as medium-confidence", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace("Ref No. 2043350406766", "2043350406766"),
  );
  assertEquals(parsed.reference.value, "2043350406766", "standalone ref");
  assertEquals(parsed.reference.source, "standalone", "standalone source");
  assertEquals(parsed.reference.confidence, "medium", "standalone confidence");
});

Deno.test("refuses two different standalone 13-digit references", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "Ref No. 2043350406766",
      "2043350406766\n2043350406767",
    ),
  );
  assertEquals(parsed.reference.value, null, "ambiguous reference");
  assert(
    parsed.issues.includes("AMBIGUOUS_REFERENCE"),
    "ambiguous reference issue",
  );
});

Deno.test("parses cross-line bare GCash amounts with label evidence", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace("₱12.00", "12.00"),
  );
  assertEquals(parsed.amount.amount, 12, "cross-line amount");
  assertEquals(parsed.amount.reliable, true, "cross-line reliability");
  assertEquals(parsed.amount.ambiguous, false, "cross-line ambiguity");
});

Deno.test("never suffix-parses a thousands GCash amount", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR
      .replace(/\n12\.00\n/, "\n1,080.00\n")
      .replace("₱12.00", "₱1,080.00"),
  );
  assertEquals(parsed.amount.amount, 1080, "thousands amount");
  assert(
    !parsed.amount.candidates.some((candidate) => candidate.amount === 80),
    "must not parse the comma tail",
  );
});

Deno.test("surfaces conflicting principal GCash amounts", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR
      .replace("Amount\n12.00", "Amount P12.00")
      .replace("₱12.00", "₱1,200.00"),
  );
  assertEquals(parsed.amount.amount, 1200, "selected total sent");
  assertEquals(
    parsed.amount.conflictingPrimaryAmounts,
    true,
    "conflicting amount diagnostic",
  );
  assert(
    parsed.issues.includes("CONFLICTING_PRIMARY_AMOUNTS"),
    "conflicting amount issue",
  );
});

Deno.test("keeps a date-only GCash timestamp incomplete", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(" Jul 28, 2026 10:41 AM", "\nJul 28, 2026"),
  );
  assertEquals(parsed.timestamp.date, "2026-07-28", "date only");
  assertEquals(parsed.timestamp.time24, null, "missing time");
  assertEquals(parsed.timestamp.instant, null, "missing instant");
  assertEquals(parsed.timestamp.completeness, "date_only", "date-only state");
});

Deno.test("rejects rollover dates and invalid twelve-hour times", () => {
  for (
    const invalidTimestamp of [
      "Jul 32, 2026 10:41 AM",
      "Jul 28, 2026 13:61 PM",
    ]
  ) {
    const parsed = parseGcashReceipt(
      USER_GCASH_OCR.replace(
        "Jul 28, 2026 10:41 AM",
        invalidTimestamp,
      ),
    );
    assertEquals(
      parsed.timestamp.completeness,
      "invalid",
      invalidTimestamp,
    );
    assert(
      parsed.issues.includes("TIMESTAMP_INVALID"),
      `${invalidTimestamp} issue`,
    );
  }
});

Deno.test("converts twelve AM and PM correctly", () => {
  const midnight = parseGcashReceipt(
    USER_GCASH_OCR.replace("10:41 AM", "12:00 AM"),
  );
  const noon = parseGcashReceipt(
    USER_GCASH_OCR.replace("10:41 AM", "12:00 PM"),
  );
  assertEquals(midnight.timestamp.time24, "00:00", "midnight");
  assertEquals(noon.timestamp.time24, "12:00", "noon");
});

for (
  const [provider, evidence] of [
    ["bdopay", "BDO Pay"],
    ["maya", "Maya\nSent money via\nInstaPay QRPh"],
    ["bpi", "BPI Online\nTransfer successful"],
  ] as const
) {
  Deno.test(`classifies ${provider} evidence on GCash as a conflict`, () => {
    const parsed = parseGcashReceipt(`${USER_GCASH_OCR}\n${evidence}`);
    assertEquals(
      parsed.indicators.classification,
      "conflict",
      `${provider} method conflict`,
    );
    assert(
      parsed.indicators.competingProviders.includes(provider),
      `${provider} indicator`,
    );
    assert(
      parsed.issues.includes("COMPETING_PROVIDER"),
      `${provider} competing-provider issue`,
    );
  });
}

Deno.test("a total amount fragment alone is not a GCash receipt", () => {
  const parsed = parseGcashReceipt("Total Amount Sent ₱12.00");
  assertEquals(
    parsed.indicators.classification,
    "insufficient",
    "fragment classification",
  );
  assert(
    parsed.issues.includes("INSUFFICIENT_GCASH_INDICATORS"),
    "insufficient indicator issue",
  );
});

// Anonymized reported layout: Google emits the Amount label above the
// recipient and strips the masking dots from both name and phone.
const DETACHED_AMOUNT_OCR = `9:06 0000.
Express Send
5G
X1566
Amount
KRE L. C.
+63 92169
Sent via GCash
1,590.00
Total Amount Sent P1,590.00
Ref No. 9044 881 673119 Sep 10, 2026 9:06 AM
2799 (CO2e)
By going digital, you reduce your carbon footprint from
transportation, paper, and plastic.`;

Deno.test("reported detached amount layout preserves both amount observations", () => {
  const parsed = parseGcashReceipt(DETACHED_AMOUNT_OCR);
  assertEquals(parsed.amount.amount, 1590, "principal amount");
  assertEquals(
    parsed.amount.matchingPrimaryAmountDisplays,
    true,
    "both displays",
  );
  assertEquals(
    parsed.amount.conflictingPrimaryAmounts,
    false,
    "consistent values",
  );
  assertEquals(parsed.receiver.phone.last4, "2169", "collapsed phone suffix");
  assertEquals(
    parsed.receiver.phone.visibility,
    "masked",
    "never invent full phone",
  );
  assertEquals(parsed.receiver.name.raw, "KRE L. C.", "independent name read");
  const comparison = compareGcashRecipient(parsed.receiver, {
    phone: "09609422169",
    name: "Kristie Lou Cachuela",
  });
  assertEquals(comparison.phone, "last4_only", "partial evidence only");
  assertEquals(comparison.name, "mismatch", "do not invent missing name masks");
  assertEquals(
    isGcashRecipientAccepted(comparison),
    false,
    "second OCR read required",
  );
});

Deno.test("detached amount recovery retains contradictions and rejects unbounded lookalikes", () => {
  const conflicting = parseGcashReceipt(
    DETACHED_AMOUNT_OCR.replace("\n1,590.00\n", "\n1,490.00\n"),
  );
  assertEquals(
    conflicting.amount.conflictingPrimaryAmounts,
    true,
    "wrong primary amount",
  );
  assertEquals(
    conflicting.amount.matchingPrimaryAmountDisplays,
    false,
    "values must agree",
  );
  for (
    const text of [
      DETACHED_AMOUNT_OCR.replace("Amount\n", ""),
      DETACHED_AMOUNT_OCR.replace("\n1,590.00\n", "\nFee\n1,590.00\n"),
      DETACHED_AMOUNT_OCR.replace(
        "\n1,590.00\n",
        "\n1,590.00\nAdvertisement\n",
      ),
      DETACHED_AMOUNT_OCR.replace("\n1,590.00\n", "\n1,590.00\n1,590.00\n"),
      DETACHED_AMOUNT_OCR.replace("\nRef No.", "\nAdvertisement\nRef No."),
      DETACHED_AMOUNT_OCR.replace("\n1,590.00\n", "\n-1,590.00\n"),
    ]
  ) {
    assertEquals(
      parseGcashReceipt(text).amount.matchingPrimaryAmountDisplays,
      false,
      text,
    );
  }
});

Deno.test("masked recipient requires matching phone suffix and strong independent name", () => {
  const expected = { phone: "09609422169", name: "Kristie Lou Cachuela" };
  for (
    const phone of [
      "+63 9•••••2169",
      "+63 9.2169",
      "+63 92169",
      "+63 960***2169",
    ]
  ) {
    const parsed = parseGcashReceipt(
      DETACHED_AMOUNT_OCR.replace("KRE L. C.", "KR••••E L•• C.").replace(
        "+63 92169",
        phone,
      ),
    );
    const comparison = compareGcashRecipient(parsed.receiver, expected);
    assertEquals(comparison.phone, "last4_only", phone);
    assertEquals(comparison.name, "masked_compatible", phone);
    assertEquals(isGcashRecipientAccepted(comparison), true, phone);
  }
  for (
    const [phone, name] of [
      ["+63 9•••••2169", ""],
      ["+63 9•••••2169", "K•• L•• C."],
      ["+63 9•••••2169", "KR••••E L•• R."],
      ["+63 9•••••2169", "KRE L. C."],
      ["+63 9•••••9999", "KR••••E L•• C."],
      ["+63 945***2169", "KR••••E L•• C."],
      ["+63 945 999 2169", "KR••••E L•• C."],
      ["+63 9•••••21•69", "KR••••E L•• C."],
      ["2169", "KR••••E L•• C."],
    ]
  ) {
    const parsed = parseGcashReceipt(
      DETACHED_AMOUNT_OCR.replace("KRE L. C.", name).replace(
        "+63 92169",
        phone,
      ),
    );
    assertEquals(
      isGcashRecipientAccepted(
        compareGcashRecipient(parsed.receiver, expected),
      ),
      false,
      `${phone} / ${name}`,
    );
  }
});

Deno.test("reported single-dot phone OCR retains the visible GCash suffix", () => {
  const parsed = parseGcashReceipt(
    DETACHED_AMOUNT_OCR.replace("KRE L. C.", "KR....E L.. C.").replace(
      "+63 92169",
      "+63 9.2169",
    ),
  );
  assertEquals(parsed.receiver.phone.last4, "2169", "visible phone suffix");
  assertEquals(parsed.receiver.phone.visibility, "masked", "masked phone");
  assertEquals(
    isGcashRecipientAccepted(
      compareGcashRecipient(parsed.receiver, {
        phone: "09609422169",
        name: "Kristie Lou Cachuela",
      }),
    ),
    true,
    "single-dot phone and independently masked name agree",
  );
});

Deno.test("original OCR recovers a reference lost by layout reconstruction", () => {
  const original = `4:46
Amount
Express Send
KR....E L.. C.
+63 960 942 2169
Sent via GCash
Total Amount Sent
LTE 68
530.00
P530.00
Ref No. 0044896805912
Sep 10, 2026 4:46 PM`;
  const layout = original.replace("\nRef No. 0044896805912", "");
  const recovered = recoverGcashReferenceText(layout, original);
  const parsed = parseGcashReceipt(recovered);
  assertEquals(parsed.reference.value, "0044896805912", "labelled OCR ref");
  assertEquals(parsed.reference.source, "ref_label", "label remains explicit");

  const visibleConflict = layout.replace(
    "Sep 10, 2026 4:46 PM",
    "Ref No. 9999999999999\nSep 10, 2026 4:46 PM",
  );
  assertEquals(
    recoverGcashReferenceText(visibleConflict, original),
    visibleConflict,
    "never replace a visible layout reference",
  );

  const ambiguousOriginal = `${original}\nRef No. 1111111111111`;
  assertEquals(
    recoverGcashReferenceText(layout, ambiguousOriginal),
    layout,
    "never recover conflicting original references",
  );
  assertEquals(
    recoverGcashReferenceText(layout, `${layout}\n0044896805912`),
    layout,
    "standalone digits are not enough for cross-reading recovery",
  );
});

Deno.test("layout recovery moves a uniquely misplaced meridiem back to the timestamp", () => {
  const original = `Express Send
KR....E L.. C.
+63 960 942 2169
Sent via GCash
Amount 530.00
Total Amount Sent P530.00
Ref No. 6044965571662 Sep 12, 2026 3:09 PM`;
  const layout = `Express Send
KR....E L.. C.
+63 960 942 2169
Sent via GCash
Amount 530.00
Total Amount Sent P530.00
Ref No. 6044965571662 PM
Sep 12, 2026 3:09`;
  const recovered = recoverGcashTimestampText(layout, original);
  const parsed = parseGcashReceipt(recovered);
  assertEquals(parsed.timestamp.time24, "15:09", "receipt time recovered");
  assertEquals(
    parsed.timestamp.completeness,
    "date_time",
    "timestamp complete",
  );
  assertEquals(parsed.reference.value, "6044965571662", "reference preserved");

  const unchanged = [
    layout.replace("3:09", "3:10"),
    layout.replace("Sep 12", "Sep 11"),
    layout.replace(" PM", " AM"),
    `${layout}\nRef No. 1111111111111 PM`,
  ];
  for (const candidate of unchanged) {
    assertEquals(
      recoverGcashTimestampText(candidate, original),
      candidate,
      "conflicting or ambiguous layout remains untouched",
    );
  }
  assertEquals(
    recoverGcashTimestampText(layout, `${original}\nSep 12, 2026 3:10 PM`),
    layout,
    "multiple raw timestamps are never reconciled",
  );
  const complete = layout.replace(
    "Ref No. 6044965571662 PM\nSep 12, 2026 3:09",
    "Ref No. 6044965571662\nSep 12, 2026 3:09 PM",
  );
  assertEquals(
    recoverGcashTimestampText(complete, original),
    complete,
    "complete layouts remain untouched",
  );
});

Deno.test("recipient name can be read without a phone but UI headings are excluded", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace("+63 998 123 4567\n", ""),
  );
  assertEquals(
    parsed.receiver.name.raw,
    "J•• KE••••H M.",
    "name independent from phone",
  );
  const noName = parseGcashReceipt("Express Send\nAmount\nSent via GCash");
  assertEquals(
    noName.receiver.name.visibility,
    "missing",
    "not a receipt heading",
  );
});
