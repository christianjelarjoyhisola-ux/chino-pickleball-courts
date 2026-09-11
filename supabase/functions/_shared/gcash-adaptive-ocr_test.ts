import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  evaluateGcashRecoveryRead,
  gcashOriginalRecoveryVeto,
  recoverGcashReceipt,
} from "./gcash-adaptive-ocr.ts";
import {
  type GcashProviderReceiptParse,
  parseProviderReceipt,
  type ReceiptVerificationContext,
} from "./receipt-providers/index.ts";
import {
  type GoogleVisionOcrResult,
  receiptImageDimensions,
} from "./google-vision.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function eq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected${JSON.stringify(expected)}, got${
        JSON.stringify(actual)
      }`,
    );
  }
}
const context: ReceiptVerificationContext = {
  typedReference: "9900123456789",
  expectedAmount: 1590,
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientNumber: "09609422169",
  expectedRecipientName: "KRISTIE LOU CACHUELA",
  bookingStartedAt: "2026-09-10T01:04:27Z",
  bookingStartedDate: "2026-09-10",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};
function read(
  options: {
    reference?: string;
    amount?: number;
    name?: string;
    phone?: string;
    confidence?: number;
    status?: string;
  } = {},
): GoogleVisionOcrResult {
  const reference = options.reference ?? "9900123456789";
  const amount = options.amount ?? 1590;
  const name = options.name ?? "KR****E L** C.";
  const phone = options.phone ?? "+63 9*****2169";
  const confidence = options.confidence ?? .98;
  const money = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const date = "Sep 10, 2026 9:06 AM";
  const text =
    `Express Send\n${name}\n${phone}\nSent via GCash\nAmount ${money}\nTotal Amount Sent P${money}\nRef No. ${reference} ${date}${
      options.status ? "\n" + options.status : ""
    }`;
  return {
    text,
    confidence: .94,
    confidenceSource: "native",
    gcashEvidence: {
      layoutText: text,
      confidence,
      confidenceSource: "native",
      fields: {
        amount: { text: money, confidence },
        totalAmount: { text: "P" + money, confidence },
        reference: { text: reference, confidence },
        dateTime: { text: date, confidence },
        recipientName: { text: name, confidence },
        recipientPhone: { text: phone, confidence },
      },
    },
  };
}
function original(input = read()) {
  return {
    read: input,
    parsed: parseProviderReceipt(
      "gcash",
      input.gcashEvidence?.layoutText || input.text,
      { typedReference: context.typedReference },
    ) as GcashProviderReceiptParse,
  };
}
function weak() {
  const result = read();
  result.gcashEvidence!.fields.reference!.confidence = .7;
  return original(result);
}
async function bytes() {
  return await new Image(120, 240).fill(0xffffffff).encode();
}

Deno.test("adaptive OCR leaves an already complete read on the fast path", async () => {
  let calls = 0;
  const result = await recoverGcashReceipt(
    await bytes(),
    original(),
    context,
    "test-key",
    {
      ocr: async () => {
        calls++;
        return read();
      },
    },
  );
  eq(result.reason, "original_complete", "fast path");
  eq(result.audit.attempted, false, "no extra reads");
  eq(calls, 0, "OCR untouched");
});

Deno.test("two full transformed views must pass and agree; preference selects canonical evidence without raising confidence", async () => {
  const input = await bytes();
  const before = input.slice();
  const observed: unknown[] = [];
  let calls = 0;
  let releaseFirst: () => void = () => {};
  const firstWaiting = new Promise<void>((resolve) => releaseFirst = resolve);
  const result = await recoverGcashReceipt(input, weak(), context, "test-key", {
    preferredStrategy: "gcash_full_enlarged_v1",
    ocr: async (_key, encoded, options) => {
      const index = calls++;
      const decoded = Uint8Array.from(
        atob(encoded),
        (character) => character.charCodeAt(0),
      );
      observed.push(receiptImageDimensions(decoded));
      assert(options?.timeoutMs! <= 10000, "shared bounded timeout");
      if (index === 0) await firstWaiting;
      else releaseFirst();
      const output = read({ confidence: index === 0 ? .96 : .94 });
      output.requestMetrics = { calls: 1, retries: 0, durationMs: 5 };
      return output;
    },
  });
  eq(result.accepted, true, "two passing readings");
  eq(
    result.selected?.strategy,
    "gcash_full_enlarged_v1",
    "trusted preference controls selected observed view",
  );
  eq(
    result.selected?.approval.confidence,
    .94,
    "minimum confidence across both readings",
  );
  eq(
    observed,
    [{ width: 180, height: 360 }, { width: 120, height: 240 }],
    "complete frame retained at two real renderings",
  );
  eq(result.audit.readings.map((reading) => reading.outcome), [
    "clean",
    "clean",
  ], "both independently pass");
  assert(
    result.audit.readings.every((reading) =>
      reading.rawText?.includes("Ref No.")
    ),
    "every original OCR read retained for audit",
  );
  eq(input, before, "original uploaded bytes unchanged");
});

Deno.test("high-confidence wrong amount, recipient, reference and pending status cannot be outvoted", async () => {
  for (
    const bad of [
      read({ amount: 1591 }),
      read({ phone: "+63 9*****9999" }),
      read({ name: "JO** D** X." }),
      read({ reference: "9900123456790" }),
      read({ status: "Processing" }),
    ]
  ) {
    let calls = 0;
    const source = original(bad);
    assert(
      gcashOriginalRecoveryVeto(source, context).length > 0,
      "original contradiction identified",
    );
    const result = await recoverGcashReceipt(
      await bytes(),
      source,
      context,
      "test-key",
      {
        ocr: async () => {
          calls++;
          return read();
        },
      },
    );
    eq(result.accepted, false, "contradiction remains review");
    eq(calls, 0, "no scans try to erase contradictory evidence");
  }
});

Deno.test("uncertain or failed alternatives never create consensus or native confidence", async () => {
  const missing = read();
  delete missing.gcashEvidence!.fields.reference;
  const heuristic = read();
  heuristic.confidenceSource = "heuristic";
  for (
    const bad of [
      read({ confidence: .89 }),
      missing,
      heuristic,
      read({ status: "Failed" }),
    ]
  ) {
    let calls = 0;
    const result = await recoverGcashReceipt(
      await bytes(),
      weak(),
      context,
      "test-key",
      { ocr: async () => ++calls === 1 ? read() : bad },
    );
    eq(result.accepted, false, "one complete scan is insufficient");
    eq(calls, 2, "bounded two views");
  }
  let calls = 0;
  const failed = await recoverGcashReceipt(
    await bytes(),
    weak(),
    context,
    "test-key",
    {
      ocr: async () => {
        if (++calls === 2) {
          throw Object.assign(new Error("temporary"), {
            requestMetrics: { calls: 2, retries: 1, durationMs: 9 },
          });
        }
        return read();
      },
    },
  );
  eq(failed.accepted, false, "network failure not a vote");
  eq(
    failed.audit.readings[1].requestMetrics?.calls,
    2,
    "failed transport attempts retained",
  );
});

Deno.test("different references or mask positions cannot agree merely because both match booking constraints", async () => {
  const untyped = { ...context, typedReference: "" };
  let calls = 0;
  const result = await recoverGcashReceipt(
    await bytes(),
    weak(),
    untyped,
    "test-key",
    {
      ocr: async () =>
        read({ reference: ++calls === 1 ? "9900123456789" : "9900123456790" }),
    },
  );
  eq(result.accepted, false, "different valid-looking references disagree");
  eq(result.reason, "recovery_readings_disagree", "canonical fields compared");
});

Deno.test("unsafe image sizes, expired preparation deadline and unknown strategies cannot alter validation", async () => {
  let calls = 0;
  const ocr = async () => {
    calls++;
    return read();
  };
  const unsafe = await recoverGcashReceipt(
    new Uint8Array([0, 1, 2]),
    weak(),
    context,
    "test-key",
    { ocr },
  );
  eq(unsafe.accepted, false, "unknown image refused");
  eq(calls, 0, "no optical request for unsafe image");
  const unknown = await recoverGcashReceipt(
    await bytes(),
    weak(),
    context,
    "test-key",
    { preferredStrategy: "skip_all_checks", ocr },
  );
  eq(unknown.accepted, true, "unknown preference cannot remove checks");
  eq(unknown.audit.preferredStrategy, undefined, "arbitrary strategy ignored");
  eq(calls, 2, "fixed validated strategies only");
});

Deno.test("1320 x 2550 GCash screenshot reaches both bounded full-image rereads", async () => {
  const input = await new Image(1320, 2550).fill(0xffffffff).encode();
  const snapshot = input.slice();
  const observed: Array<{ width: number; height: number }> = [];
  const result = await recoverGcashReceipt(
    input,
    weak(),
    context,
    "test-key",
    {
      ocr: async (_key, encoded, options) => {
        const png = Uint8Array.from(
          atob(encoded),
          (value) => value.charCodeAt(0),
        );
        const dimensions = receiptImageDimensions(png)!;
        observed.push(dimensions);
        assert(png.length <= 4 * 1024 * 1024, "encoded retry stays bounded");
        assert(
          options?.timeoutMs! > 0 && options?.timeoutMs! <= 10000,
          "preparation shares the recovery deadline",
        );
        return read();
      },
    },
  );
  eq(result.accepted, true, result.reason);
  eq(observed.length, 2, "large screenshot receives both optical strategies");
  assert(
    observed[0].width * observed[0].height <= 2_000_000,
    "contrast view fits 2 MP",
  );
  assert(
    observed[1].width * observed[1].height <= 4_000_000,
    "color view fits 4 MP",
  );
  assert(observed[1].width > observed[0].width, "views stay independent");
  for (const dimensions of observed) {
    assert(
      Math.abs(dimensions.width / dimensions.height - 1320 / 2550) < .001,
      "full receipt aspect ratio is preserved",
    );
  }
  eq(input, snapshot, "uploaded receipt remains unchanged");
});

Deno.test("GCash recovery rejects oversized headers before decode or OCR", async () => {
  let calls = 0;
  for (const [width, height] of [[4000, 2500], [5000, 100]]) {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    const header = new DataView(png.buffer);
    header.setUint32(16, width);
    header.setUint32(20, height);
    const result = await recoverGcashReceipt(
      png,
      weak(),
      context,
      "test-key",
      {
        ocr: async () => {
          calls++;
          return read();
        },
      },
    );
    eq(result.reason, "recovery_image_unavailable", "unsafe image refused");
    eq(result.audit.attempted, false, "unsafe image has no OCR attempt");
  }
  eq(calls, 0, "unsafe headers never reach OCR");
});

Deno.test("candidate evaluator preserves dedupe key for the independent database replay guard", () => {
  const candidate = evaluateGcashRecoveryRead(
    "gcash_full_contrast_v1",
    read(),
    context,
  );
  eq(candidate.reading.outcome, "clean", "valid optical evidence");
  eq(
    candidate.selected.parsed.receipt.reference.value,
    "9900123456789",
    "same reference forwarded for database dedupe",
  );
  eq(candidate.reading.confidence, .98, "score comes from native fields");
});

Deno.test("receipt-only retries conserve a strong original reference even when two alternatives agree on another", async () => {
  const source = read();
  source.gcashEvidence!.fields.recipientName!.confidence = .8;
  const untyped = { ...context, typedReference: "" };
  const sourceOriginal = {
    read: source,
    parsed: parseProviderReceipt(
      "gcash",
      source.text,
    ) as GcashProviderReceiptParse,
  };
  const result = await recoverGcashReceipt(
    await bytes(),
    sourceOriginal,
    untyped,
    "test-key",
    { ocr: async () => read({ reference: "9900123456790" }) },
  );
  eq(
    result.accepted,
    false,
    "reference cannot change under an unrelated uncertainty",
  );
  eq(result.reason, "recovery_conflict", "original reference vetoes agreement");
  assert(
    result.audit.readings.every((reading) =>
      reading.flags.includes("ORIGINAL_REFERENCE_CONFLICT")
    ),
    "specific conservation evidence retained",
  );
});

Deno.test("retry cannot change a strong timestamp inside the valid window or erase a fully observed phone", async () => {
  const source = read();
  source.gcashEvidence!.fields.recipientName!.confidence = .8;
  const changedTime = read();
  changedTime.text = changedTime.text.replace("9:06 AM", "9:07 AM");
  changedTime.gcashEvidence!.layoutText = changedTime.text;
  changedTime.gcashEvidence!.fields.dateTime!.text = "Sep 10, 2026 9:07 AM";
  const timeResult = await recoverGcashReceipt(
    await bytes(),
    original(source),
    context,
    "test-key",
    { ocr: async () => changedTime },
  );
  eq(timeResult.accepted, false, "valid but different time remains a conflict");
  assert(
    timeResult.audit.readings.every((reading) =>
      reading.flags.includes("ORIGINAL_TIMESTAMP_CONFLICT")
    ),
    "time conservation flag",
  );
  const full = read({ phone: "09609422169" });
  full.gcashEvidence!.fields.reference!.confidence = .7;
  const phoneResult = await recoverGcashReceipt(
    await bytes(),
    original(full),
    context,
    "test-key",
    { ocr: async () => read() },
  );
  eq(
    phoneResult.accepted,
    false,
    "full recipient digits cannot be discarded by retries",
  );
  assert(
    phoneResult.audit.readings.every((reading) =>
      reading.flags.includes("ORIGINAL_RECIPIENT_PHONE_CONFLICT")
    ),
    "full phone conservation flag",
  );
});

Deno.test("two strongly read conflicting amount displays cannot be hidden by an ambiguous aggregate parse", async () => {
  const conflicting = read();
  conflicting.text = conflicting.text.replace(
    "Amount 1,590.00",
    "Amount 1,580.00",
  );
  conflicting.gcashEvidence!.layoutText = conflicting.text;
  conflicting.gcashEvidence!.fields.amount!.text = "1,580.00";
  let calls = 0;
  const result = await recoverGcashReceipt(
    await bytes(),
    original(conflicting),
    context,
    "test-key",
    {
      ocr: async () => {
        calls++;
        return read();
      },
    },
  );
  eq(result.accepted, false, "conflicting amount observations remain review");
  eq(calls, 0, "do not retry away reliable conflicting displays");
});
