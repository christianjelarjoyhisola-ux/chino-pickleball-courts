import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  bankOriginalRecoveryVeto,
  evaluateBankRecoveryRead,
  recoverBankReceipt,
} from "./bank-adaptive-ocr.ts";
import {
  BANK_FIXTURES,
  bankFixtureOriginal,
  bankFixtureRead,
} from "./bank-ocr-fixtures.ts";
import { receiptImageDimensions } from "./google-vision.ts";
function eq(actual: unknown, expected: unknown, message = "equality") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function imageBytes() {
  return await new Image(120, 240).fill(0xffffffff).encode();
}
function weak(fixture = BANK_FIXTURES[0]) {
  const original = bankFixtureOriginal(fixture);
  const field = original.read.nativeLines!.flatMap((line) => line.words).find((
    word,
  ) =>
    /\d/.test(word.text) &&
    original.parsed.receipt.reference.raw!.replace(/\s/g, "").includes(
      word.text.replace(/\s/g, ""),
    )
  )!;
  field.confidence = .65;
  return original;
}

for (const fixture of BANK_FIXTURES) {
  Deno.test(`${fixture.provider} full-image recovery requires two clean matching native readings`, async () => {
    let calls = 0;
    const result = await recoverBankReceipt(
      await imageBytes(),
      weak(fixture),
      fixture.context,
      "test",
      {
        ocr: async () => {
          calls++;
          return bankFixtureRead(fixture.text);
        },
      },
    );
    eq(calls, 2);
    eq(result.accepted, true, JSON.stringify(result.audit));
    eq(result.reason, "full_readings_agree");
    eq(result.selected?.approval.confidence, .97);
    eq(result.audit.readings.map((item) => item.outcome), ["clean", "clean"]);
  });
}

Deno.test("complete payment evidence fast path performs no extra calls", async () => {
  let calls = 0;
  const fixture = BANK_FIXTURES[0];
  const result = await recoverBankReceipt(
    await imageBytes(),
    bankFixtureOriginal(fixture),
    fixture.context,
    "test",
    {
      ocr: async () => {
        calls++;
        return bankFixtureRead(fixture.text);
      },
    },
  );
  eq(calls, 0);
  eq(result.reason, "original_complete");
  eq(result.audit.attempted, false);
});

Deno.test("different full views run concurrently under one bounded deadline and preserve original image", async () => {
  const fixture = BANK_FIXTURES[0],
    bytes = await imageBytes(),
    snapshot = bytes.slice();
  let calls = 0, release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => release = resolve);
  const dimensions: unknown[] = [];
  const result = await recoverBankReceipt(
    bytes,
    weak(),
    fixture.context,
    "test",
    {
      preferredStrategy: "bank_full_enlarged_v1",
      ocr: async (_key, encoded, options) => {
        const index = calls++;
        dimensions.push(
          receiptImageDimensions(
            Uint8Array.from(
              atob(encoded),
              (character) => character.charCodeAt(0),
            ),
          ),
        );
        assert(options?.timeoutMs! <= 10000, "shared deadline");
        eq(options?.featureType, "DOCUMENT_TEXT_DETECTION");
        if (!index) await waiting;
        else release();
        const read = bankFixtureRead(fixture.text, index ? .96 : .94);
        read.requestMetrics = { calls: 2, retries: 1, durationMs: 20 };
        return read;
      },
    },
  );
  eq(result.accepted, true);
  eq(result.selected?.strategy, "bank_full_enlarged_v1");
  eq(result.selected?.approval.confidence, .94, "minimum confidence not votes");
  eq(dimensions, [{ width: 180, height: 360 }, { width: 120, height: 240 }]);
  eq(bytes, snapshot);
  eq(result.audit.readings.map((item) => item.requestMetrics?.calls), [2, 2]);
});

Deno.test("original pending or failed transfer performs zero recovery requests", async () => {
  const fixture = BANK_FIXTURES[0];
  for (const status of ["Processing", "Reversed", "Pending", "Failed"]) {
    const original = bankFixtureOriginal(
      fixture,
      bankFixtureRead(fixture.text + "\n" + status),
    );
    let calls = 0;
    const result = await recoverBankReceipt(
      await imageBytes(),
      original,
      fixture.context,
      "test",
      {
        ocr: async () => {
          calls++;
          return bankFixtureRead(fixture.text);
        },
      },
    );
    eq(calls, 0);
    eq(result.reason, "original_conflict:PAYMENT_STATUS_NOT_COMPLETED");
  }
});

Deno.test("a single adverse reread overrides matching successful heading", async () => {
  const fixture = BANK_FIXTURES[0];
  let calls = 0;
  const result = await recoverBankReceipt(
    await imageBytes(),
    weak(),
    fixture.context,
    "test",
    {
      ocr: async () =>
        bankFixtureRead(fixture.text + (calls++ ? "\nPending" : "")),
    },
  );
  eq(result.accepted, false);
  eq(result.reason, "recovery_conflict");
});

Deno.test("known original financial mismatch is not rewritten to match the booking", () => {
  const fixture = BANK_FIXTURES[0], original = bankFixtureOriginal(fixture);
  assert(
    bankOriginalRecoveryVeto(original, {
      ...fixture.context,
      expectedAmount: 700,
    }).includes("AMOUNT_MISMATCH"),
    "native wrong amount veto",
  );
  assert(
    bankOriginalRecoveryVeto(original, {
      ...fixture.context,
      expectedRecipientNumber: "09981234568",
    }).length > 0,
    "native wrong recipient veto",
  );
});

Deno.test("one trustworthy wrong original amount display is conserved even if its duplicate is weak", () => {
  const fixture = BANK_FIXTURES[1], original = bankFixtureOriginal(fixture);
  const displays = original.read.nativeLines!.flatMap((line) => line.words)
    .filter((word) => word.text === "1,600.00");
  displays[1].confidence = .6;
  assert(
    bankOriginalRecoveryVeto(original, {
      ...fixture.context,
      expectedAmount: 1500,
    }).includes("AMOUNT_MISMATCH"),
    "the clear first amount cannot be outvoted",
  );
});

Deno.test("matching retries cannot rewrite trustworthy receipt-only reference", async () => {
  const fixture = BANK_FIXTURES[0], original = bankFixtureOriginal(fixture);
  const reference = "B794 2F55 EC98";
  const context = { ...fixture.context, typedReference: undefined };
  // A low timestamp triggers recovery, but the high-confidence reference stays.
  original.read.nativeLines!.flatMap((line) => line.words).find((word) =>
    word.text === "12:02"
  )!.confidence = .65;
  const result = await recoverBankReceipt(
    await imageBytes(),
    original,
    context,
    "test",
    {
      ocr: async () =>
        bankFixtureRead(fixture.text.replace("B794 2F55 EC99", reference)),
    },
  );
  eq(result.reason, "recovery_conflict");
  assert(
    result.audit.readings.every((item) =>
      item.flags.includes("ORIGINAL_REFERENCE_CONFLICT")
    ),
    "reference conserved",
  );
});

Deno.test("timestamp and fee changes cannot be voted away even inside booking tolerance", () => {
  const fixture = BANK_FIXTURES[0], original = weak();
  const changed = fixture.text.replace("12:02", "12:03").replace(
    "₱10.00",
    "₱11.00",
  );
  const evaluated = evaluateBankRecoveryRead(
    "bank_full_contrast_v1",
    bankFixtureRead(changed),
    original,
    fixture.context,
  );
  assert(
    evaluated.reading.flags.includes("ORIGINAL_TIMESTAMP_CONFLICT"),
    "observed exact instant conserved",
  );
  assert(
    evaluated.reading.flags.includes("ORIGINAL_FEE0_CONFLICT"),
    "observed fee conserved",
  );
  eq(evaluated.reading.outcome, "conflict");
});

Deno.test("secondary IDs and full recipient accounts cannot disappear or become masked", () => {
  const fixture = BANK_FIXTURES[0], original = weak();
  const changed = fixture.text.replace("797289", "797288").replace(
    "09981234567",
    "*******4567",
  );
  const evaluated = evaluateBankRecoveryRead(
    "bank_full_contrast_v1",
    bankFixtureRead(changed),
    original,
    fixture.context,
  );
  assert(
    evaluated.reading.flags.includes("ORIGINAL_SECONDARY_REFERENCE_CONFLICT"),
    "secondary ID conserved",
  );
  assert(
    evaluated.reading.flags.includes("ORIGINAL_RECIPIENT_ACCOUNT_CONFLICT"),
    "full account conserved",
  );
});

Deno.test("two low-original-reference reads with different observed references remain pending", async () => {
  const fixture = BANK_FIXTURES[0];
  let calls = 0;
  const original = weak();
  // Lower every native word of the original reference, without adding a typed reference.
  original.read.nativeLines!.filter((line) => line.text.includes("B794"))
    .flatMap((line) => line.words).forEach((word) => word.confidence = .65);
  const result = await recoverBankReceipt(
    await imageBytes(),
    original,
    { ...fixture.context, typedReference: undefined },
    "test",
    {
      ocr: async () =>
        bankFixtureRead(
          fixture.text.replace("EC99", calls++ ? "EC97" : "EC98"),
        ),
    },
  );
  eq(result.accepted, false);
  eq(result.reason, "recovery_readings_disagree");
});

Deno.test("one unavailable reread stays pending with actual attempt metrics", async () => {
  const fixture = BANK_FIXTURES[0];
  let calls = 0;
  const result = await recoverBankReceipt(
    await imageBytes(),
    weak(),
    fixture.context,
    "test",
    {
      ocr: async () => {
        if (calls++) {
          throw Object.assign(new Error("unavailable"), {
            requestMetrics: { calls: 2, retries: 1, durationMs: 7 },
          });
        }
        return bankFixtureRead(fixture.text);
      },
    },
  );
  eq(result.accepted, false);
  eq(result.reason, "transport_unavailable");
  eq(result.audit.readings[1].requestMetrics, {
    calls: 2,
    retries: 1,
    durationMs: 7,
  });
});

Deno.test("page-only confidence cannot approve recovery even when both full texts pass", async () => {
  const fixture = BANK_FIXTURES[0];
  const result = await recoverBankReceipt(
    await imageBytes(),
    weak(),
    fixture.context,
    "test",
    {
      ocr: async () => {
        const read = bankFixtureRead(fixture.text);
        delete read.nativeLines;
        read.confidence = .99;
        return read;
      },
    },
  );
  eq(result.accepted, false);
  eq(result.reason, "recovery_incomplete");
});

Deno.test("unknown receipt layout and malformed images never consume recovery requests", async () => {
  const fixture = BANK_FIXTURES[0];
  let calls = 0;
  const ocr = async () => {
    calls++;
    return bankFixtureRead(fixture.text);
  };
  const original = bankFixtureOriginal(
    fixture,
    bankFixtureRead(
      fixture.text.replace("Sent money via", "Receipt details"),
      .5,
    ),
  );
  const result = await recoverBankReceipt(
    await imageBytes(),
    original,
    fixture.context,
    "test",
    { ocr },
  );
  eq(result.reason, "recovery_layout_unavailable");
  eq(
    (await recoverBankReceipt(
      new Uint8Array(),
      weak(),
      fixture.context,
      "test",
      { ocr },
    )).reason,
    "recovery_image_unavailable",
  );
  eq(calls, 0);
});
