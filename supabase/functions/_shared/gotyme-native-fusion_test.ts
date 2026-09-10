import {
  BANK_FIXTURES,
  bankFixtureOriginal,
  bankFixtureRead,
} from "./bank-ocr-fixtures.ts";
import {
  type GotymeNativeFusionInput,
  recoverGotymeNativeFields,
} from "./gotyme-native-fusion.ts";
function eq(a: unknown, b: unknown, note = "equality") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${note}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assert(value: unknown, note: string): asserts value {
  if (!value) throw new Error(note);
}
const fixture = BANK_FIXTURES[3];
function weak(
  read: ReturnType<typeof bankFixtureRead>,
  token: string,
  confidence: number,
) {
  for (
    const word of read.nativeLines!.flatMap((line) => line.words).filter((
      word,
    ) => word.text.includes(token))
  ) {
    word.confidence = confidence;
    word.symbols.forEach((symbol) => symbol.confidence = confidence);
  }
}
function input(): GotymeNativeFusionInput {
  const text = fixture.text.replaceAll("9WO7", "9W07"),
    original = bankFixtureRead(
      text.replace("Amount ₱265.00", "Amount $265.00"),
    ),
    candidate = bankFixtureRead(text);
  for (const read of [original, candidate]) {
    weak(read, "9W07", .5);
    const fee = read.nativeLines!.flatMap((line) => line.words).find((word) =>
      word.text === "₱0.00"
    )!;
    fee.confidence = .82;
    fee.symbols.forEach((symbol) =>
      symbol.confidence = symbol.text === "₱" ? .4 : .98
    );
  }
  weak(original, "KR****E", .903);
  weak(candidate, "KR****E", .89);
  weak(candidate, "₱265.00", .922);
  return {
    original: bankFixtureOriginal(fixture, original),
    candidates: [{
      strategy: "full_contrast",
      ...bankFixtureOriginal(fixture, candidate),
    }],
    context: { ...fixture.context },
  };
}
Deno.test("native fusion reads principal without changing or upgrading an unresolved account", () => {
  const value = input(),
    snapshot = JSON.stringify(value),
    got = recoverGotymeNativeFields(value);
  eq(got.safeToUse, true, JSON.stringify(got));
  eq(got.applied, true);
  eq(got.parsed.receipt.amount.amount, 265);
  eq(got.parsed.receipt.amount.reliable, true);
  eq(got.parsed.receipt.recipient.accountRaw, "****************9W07");
  eq(got.approval.confidence, .5);
  eq(got.cleanBeforeDuplicateCheck, false);
  eq(got.usedFields.recipientName.readId, "original");
  eq(got.usedFields.recipientName.confidence, .903);
  eq(got.usedFields.amount.readId, "full_contrast:0");
  eq(got.usedFields.amount.confidence, .922);
  eq(got.usedFields.fee0.confidence, .98);
  eq(got.usedFields.recipientAccount.readId, "original");
  assert(!got.flags.includes("AMOUNT_UNREADABLE"), JSON.stringify(got.flags));
  assert(
    got.flags.includes("RECEIVER_ACCOUNT_MISMATCH"),
    JSON.stringify(got.flags),
  );
  eq(JSON.stringify(value), snapshot);
  eq(got.requiresCallerDuplicateCheck, true);
});
Deno.test("later high same-value account does not upgrade original low account", () => {
  const value = input();
  weak(value.candidates[0].read, "9W07", .99);
  value.context.expectedRecipientAccount = "TESTMERCHANT9W07";
  const got = recoverGotymeNativeFields(value);
  eq(got.approval.confidence, .5);
  eq(got.cleanBeforeDuplicateCheck, false);
  assert(got.flags.includes("LOW_OCR_CONFIDENCE"), JSON.stringify(got.flags));
});
Deno.test("missing account stays missing and manual when principal can be recovered", () => {
  const value = input();
  value.original.read = bankFixtureRead(
    value.original.read.text.replace("****************9W07", "***"),
  );
  const got = recoverGotymeNativeFields(value);
  eq(got.parsed.receipt.recipient.accountRaw, null);
  eq(got.cleanBeforeDuplicateCheck, false);
  eq(got.approval.confidence, 0);
});
Deno.test("no candidate principal is chosen using expected price", () => {
  const value = input(),
    wrong = bankFixtureRead(
      fixture.text.replaceAll("265.00", "300.00").replaceAll("9WO7", "9W07"),
    );
  weak(wrong, "9W07", .5);
  value.candidates.unshift({
    strategy: "first_wrong",
    ...bankFixtureOriginal(fixture, wrong),
  });
  const got = recoverGotymeNativeFields(value);
  eq(got.safeToUse, false);
  assert(
    got.conservationFlags.includes("STRONG_GOOGLE_TOTAL0_CONFLICT"),
    JSON.stringify(got.flags),
  );
  eq(
    got.parsed.receipt.amount.amount,
    null,
    "a later fitting read cannot wash the strong disagreement",
  );
});
Deno.test("strong differing account name reference time fee and amount remain vetoes", () => {
  for (
    const [before, after] of [
      ["9W07", "9WO7"],
      ["KR****E", "KR****F"],
      ["ITO260909055941016", "ITO260909055941017"],
      ["1:59 PM", "2:00 PM"],
      ["Fee ₱0.00", "Fee ₱5.00"],
      ["Amount ₱265.00", "Amount ₱266.00"],
    ]
  ) {
    const value = input(),
      read = bankFixtureRead(
        fixture.text.replaceAll("9WO7", "9W07").replace(before, after),
      );
    value.candidates.push({
      strategy: "contradiction",
      ...bankFixtureOriginal(fixture, read),
    });
    const got = recoverGotymeNativeFields(value);
    eq(got.safeToUse, false, `${before}: ${JSON.stringify(got.flags)}`);
    eq(got.cleanBeforeDuplicateCheck, false);
  }
});
Deno.test("unusable layout/native geometry does not invent a conflicting field", () => {
  const value = input(),
    unavailable = bankFixtureRead("Transferred\nGoTyme\nTo\nGCash");
  delete unavailable.nativeLines;
  delete unavailable.layoutText;
  value.candidates.push({
    strategy: "unavailable",
    ...bankFixtureOriginal(fixture, unavailable),
  });
  eq(recoverGotymeNativeFields(value).safeToUse, true);
  unavailable.text += "\nReversed";
  const got = recoverGotymeNativeFields(value);
  eq(got.safeToUse, false);
  assert(
    got.flags.includes("PAYMENT_STATUS_NOT_COMPLETED"),
    JSON.stringify(got.flags),
  );
});
Deno.test("native glyph currency confidence stays strict for nonzero principal", () => {
  const value = input();
  weak(value.candidates[0].read, "₱265.00", .89);
  const got = recoverGotymeNativeFields(value);
  eq(got.recoveredFields, []);
  eq(got.parsed.receipt.amount.amount, null);
  eq(got.cleanBeforeDuplicateCheck, false);
});

Deno.test("missing candidate totals or fees cannot bypass retained original arithmetic", () => {
  for (
    const [originalBefore, originalAfter, candidateRemove] of [
      ["Total ₱265.00", "Total ₱300.00", "Total ₱265.00\n"],
      ["Fee ₱0.00", "Fee ₱5.00", "Fee ₱0.00\n"],
      ["Transferred\n₱265.00", "Transferred\n₱300.00", ""],
    ]
  ) {
    const value = input();
    value.original.read = bankFixtureRead(
      value.original.read.text.replace(originalBefore, originalAfter),
    );
    weak(value.original.read, "9W07", .5);
    value.candidates[0].read = bankFixtureRead(
      value.candidates[0].read.text.replace(candidateRemove, ""),
    );
    weak(value.candidates[0].read, "9W07", .5);
    const got = recoverGotymeNativeFields(value);
    eq(got.safeToUse, false);
    eq(got.cleanBeforeDuplicateCheck, false);
    assert(
      got.flags.includes("ORIGINAL_FINANCIAL_ROWS_CONFLICT"),
      JSON.stringify(got.flags),
    );
  }
});

Deno.test("split Amount label/value is copied verbatim and still checks original totals", () => {
  const value = input();
  value.original.read = bankFixtureRead(
    value.original.read.text.replace("Amount $265.00", "Amount\n$265.00"),
  );
  weak(value.original.read, "9W07", .5);
  value.candidates[0].read = bankFixtureRead(
    value.candidates[0].read.text.replace("Amount ₱265.00", "Amount\n₱265.00"),
  );
  weak(value.candidates[0].read, "9W07", .5);
  const got = recoverGotymeNativeFields(value);
  eq(got.safeToUse, true, JSON.stringify(got.flags));
  eq(got.parsed.receipt.amount.amount, 265);
  eq(got.cleanBeforeDuplicateCheck, false);
});
Deno.test("first original strong same-value evidence wins over a higher later percentage", () => {
  const value = input();
  weak(value.candidates[0].read, "KR****E", .99);
  const got = recoverGotymeNativeFields(value);
  eq(got.usedFields.recipientName.confidence, .903);
  eq(got.usedFields.recipientName.readId, "original");
});
Deno.test("fully strong original account plus recovered amount may be clean only before duplicate checks", () => {
  const value = input();
  value.context.expectedRecipientAccount = "TESTMERCHANT9W07";
  weak(value.original.read, "9W07", .97);
  const got = recoverGotymeNativeFields(value);
  eq(got.safeToUse, true);
  eq(got.cleanBeforeDuplicateCheck, true, JSON.stringify(got.flags));
  eq(got.approval.confidence, .903);
  eq(got.verification.dedupeKeys.map((item) => item.key), [
    "gotyme:ITO260909055941016",
    "instapay:941016",
  ]);
  eq(got.requiresCallerDuplicateCheck, true);
});
Deno.test("raw pending and competing provider cannot disappear behind a readable crop", () => {
  for (
    const status of ["Pending", "Processing", "Failed", "Refunded", "Reversed"]
  ) {
    const value = input();
    value.original.read.text += `\n${status}`;
    const got = recoverGotymeNativeFields(value);
    eq(got.safeToUse, false);
    assert(got.flags.includes("PAYMENT_STATUS_NOT_COMPLETED"), status);
  }
  const value = input();
  value.candidates[0].read.text += "\nMariBank";
  value.candidates[0].read.layoutText += "\nMariBank";
  const got = recoverGotymeNativeFields(value);
  eq(got.safeToUse, false);
  assert(got.flags.includes("METHOD_MISMATCH"), JSON.stringify(got.flags));
});

Deno.test("name-only policy retains low account and reconciled zero fee as optional native evidence", () => {
  const value = input();
  value.context.gotymeRecipientPolicy = "masked_name_only";
  for (const source of [value.original, value.candidates[0]]) {
    weak(source.read, "₱0.00", .49);
  }
  const got = recoverGotymeNativeFields(value);
  eq(got.safeToUse, true, JSON.stringify(got.flags));
  eq(got.cleanBeforeDuplicateCheck, true, JSON.stringify(got.flags));
  eq(got.approval.confidence, .903);
  eq(got.parsed.receipt.recipient.accountRaw, "****************9W07");
  eq(got.approval.optionalFields?.recipientAccount.confidence, .5);
  eq(
    got.approval.optionalFields?.recipientAccount.optionalReason,
    "gotyme_recipient_policy",
  );
  eq(got.approval.optionalFields?.fee0.confidence, .49);
  eq(got.approval.optionalFields?.fee0.optionalReason, "zero_fee_reconciled");
  eq(got.usedFields.recipientAccount.readId, "original");
  eq(got.usedFields.fee0.readId, "original");
  assert(
    "recipientPolicy" in got.verification,
    "recipient policy audit retained",
  );
  eq(got.verification.recipientPolicy, "masked_name_only");
  eq(got.requiresCallerDuplicateCheck, true);
});

Deno.test("name-only policy excludes account disagreements but preserves strong name and financial vetoes", () => {
  const value = input();
  value.context.gotymeRecipientPolicy = "masked_name_only";
  const differingAccount = bankFixtureRead(fixture.text);
  value.candidates.push({
    strategy: "different_account",
    ...bankFixtureOriginal(fixture, differingAccount),
  });
  const got = recoverGotymeNativeFields(value);
  eq(got.cleanBeforeDuplicateCheck, true, JSON.stringify(got.flags));
  eq(got.parsed.receipt.recipient.accountRaw, "****************9W07");
  eq(got.approval.optionalFields?.recipientAccount.confidence, .5);
  for (
    const [before, after] of [["KR****E", "KR****F"], [
      "Fee ₱0.00",
      "Fee ₱5.00",
    ], ["Total ₱265.00", "Total ₱300.00"]]
  ) {
    const negative = structuredClone(value);
    const read = bankFixtureRead(fixture.text.replace(before, after));
    negative.candidates.push({
      strategy: "strong_conflict",
      ...bankFixtureOriginal(fixture, read),
    });
    const result = recoverGotymeNativeFields(negative);
    eq(result.safeToUse, false, `${before}: ${JSON.stringify(result.flags)}`);
    eq(result.cleanBeforeDuplicateCheck, false);
  }
});

Deno.test("name-only policy still requires a matching strongly observed masked name", () => {
  for (const kind of ["unreadable", "wrong", "unconfigured"]) {
    const value = input();
    value.context.gotymeRecipientPolicy = "masked_name_only";
    if (kind === "unreadable") weak(value.original.read, "KR****E", .89);
    if (kind === "wrong") {
      value.context.expectedRecipientName = "ANOTHER PERSON";
    }
    if (kind === "unconfigured") value.context.expectedRecipientName = "";
    const got = recoverGotymeNativeFields(value);
    eq(got.cleanBeforeDuplicateCheck, false, kind);
    assert(got.flags.length, kind);
  }
});
