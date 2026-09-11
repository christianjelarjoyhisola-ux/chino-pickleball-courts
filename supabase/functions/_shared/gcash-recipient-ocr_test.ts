import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { compareGcashRecipient, parseGcashReceipt } from "./gcash-receipt.ts";
import { receiptImageDimensions } from "./google-vision.ts";
import {
  refineGcashRecipient,
  rereadGcashRecipient,
  validGcashRecipientCrop,
} from "./gcash-recipient-ocr.ts";

function assertEquals(actual: unknown, expected: unknown, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const primary = (name = "KRE L. C.", phone = "+63 92169") =>
  parseGcashReceipt(`Express Send
${name}
${phone}
Sent via GCash
Amount 1,590.00
Total Amount Sent ₱1,590.00
Ref No. 9044 881673119 Sep 10, 2026 9:06 AM`);
const cropText = "KR••••E L•• C.\n+63 9•••••2169";
const observation = (text = cropText) => ({
  text,
  confidence: 0.97,
  confidenceSource: "native" as const,
  recipientCropEvidence: {
    name: { text: text.split("\n")[0] || "", confidence: 0.97 },
    phone: { text: text.split("\n")[1] || "", confidence: 0.98 },
    confidence: 0.97,
    confidenceSource: "native" as const,
    basis: "visible_character_symbols" as const,
  },
});
const region = { x: 20, y: 30, width: 160, height: 60 };

Deno.test("GCash two optical views restore observed masks without expected account data", () => {
  const original = primary();
  const snapshot = structuredClone(original);
  const result = refineGcashRecipient(original, {
    native: observation(),
    enlarged: observation("KR****E L** C.\n+63 9*****2169"),
  });
  assertEquals(result.accepted, true);
  assertEquals(result.changed, true);
  assertEquals(result.receiver.name.raw, "KR••••E L•• C.");
  assertEquals(result.receiver.phone.raw, "+63 9•••••2169");
  assertEquals(result.confidence, 0.97);
  assertEquals(
    result.receiver.name.lineIndex,
    original.receiver.name.lineIndex,
  );
  assertEquals(original, snapshot, "primary data remains unchanged");
  assertEquals(
    compareGcashRecipient(result.receiver, {
      phone: "09609422169",
      name: "KRISTIE LOU CACHUELA",
    }).name,
    "masked_compatible",
    "normal verification uses observed recovered mask",
  );
  assertEquals(
    result.observations[0].text,
    cropText,
    "native crop OCR is retained verbatim",
  );
});

Deno.test("GCash optical refinement rejects changed names, phone digits and disagreeing crops", () => {
  const tests = [
    {
      original: primary(),
      native: observation(cropText.replace("KR", "JR")),
      enlarged: observation(cropText.replace("KR", "JR")),
      reason: "crop_name_changed",
    },
    {
      original: primary(),
      native: observation(cropText.replace("2169", "2179")),
      enlarged: observation(cropText.replace("2169", "2179")),
      reason: "crop_phone_changed",
    },
    {
      original: primary("KR••••E L•• C.", "09609422169"),
      native: observation(),
      enlarged: observation(),
      reason: "crop_phone_changed",
    },
    {
      original: primary(),
      native: observation(),
      enlarged: observation(cropText.replace("2169", "2179")),
      reason: "crop_recipients_disagree",
    },
    {
      original: primary(),
      native: observation(),
      enlarged: observation(cropText.replace("KR••••E", "KRE")),
      reason: "crop_recipients_disagree",
    },
  ];
  for (const test of tests) {
    const result = refineGcashRecipient(test.original, test);
    assertEquals(result.accepted, false);
    assertEquals(result.reason, test.reason);
    assertEquals(result.receiver, test.original.receiver);
  }
});

Deno.test("GCash reconciles only a high-confidence single mask dropout with two-of-three structure", () => {
  const original = primary("KR••••E L•• C.", "+63 960 942 2169");
  const complete = observation("KR....E L.. C.\n+63 960 942 2169");
  const dropped = observation("KR....E L. C.\n+63 960 942 2169");
  dropped.recipientCropEvidence.name.confidence = 0.943793474;
  complete.recipientCropEvidence.name.confidence = 0.9171828;
  for (const crops of [
    { native: dropped, enlarged: complete },
    { native: complete, enlarged: dropped },
  ]) {
    const result = refineGcashRecipient(original, crops);
    assertEquals(result.accepted, true);
    assertEquals(result.changed, false);
    assertEquals(result.reason, "mask_dropout_agreement");
    assertEquals(result.receiver.name.raw, "KR....E L.. C.");
    assertEquals(result.receiver.phone.raw, "+63 960 942 2169");
    assertEquals(result.confidence, 0.9171828);
    assertEquals(
      result.observations.map((item) => item.text),
      [crops.native.text, crops.enlarged.text],
      "raw optical observations remain auditable",
    );
  }
});

Deno.test("GCash mask-dropout exception rejects character, mask-position and phone ambiguity", () => {
  const original = primary("KR••••E L•• C.", "+63 960 942 2169");
  const complete = "KR....E L.. C.\n+63 960 942 2169";
  for (const other of [
    "JR....E L. C.\n+63 960 942 2169",
    "K....RE L. C.\n+63 960 942 2169",
    "KRE L. C.\n+63 960 942 2169",
    "KR....E L. C.\n+63 960 942 2179",
    "KR....E L. C.\n+63 9.....2169",
  ]) {
    const result = refineGcashRecipient(original, {
      native: observation(other),
      enlarged: observation(complete),
    });
    assertEquals(result.accepted, false);
    assertEquals(result.reason, "crop_recipients_disagree");
  }
  const bothDropped = refineGcashRecipient(original, {
    native: observation("KR....E L. C.\n+63 960 942 2169"),
    enlarged: observation("KR....E L. C.\n+63 960 942 2169"),
  });
  assertEquals(bothDropped.accepted, false);
  assertEquals(bothDropped.reason, "crop_name_changed");
});

Deno.test("GCash crop scores must be native and above threshold in both views", () => {
  for (
    const bad of [
      {
        ...observation(),
        recipientCropEvidence: {
          ...observation().recipientCropEvidence,
          name: { text: cropText.split("\n")[0], confidence: 0.89 },
        },
      },
      { ...observation(), recipientCropEvidence: undefined },
      {
        ...observation(),
        recipientCropEvidence: {
          ...observation().recipientCropEvidence,
          name: { text: cropText.split("\n")[0], confidence: undefined },
        },
      },
      { ...observation(), confidence: Number.NaN },
      { ...observation(), confidence: 1.01 },
      { ...observation(), confidenceSource: "heuristic" as const },
    ]
  ) {
    const result = refineGcashRecipient(primary(), {
      native: observation(),
      enlarged: bad,
    });
    assertEquals(result.accepted, false);
    assertEquals(result.reason, "crop_confidence_insufficient");
    assertEquals(result.confidence, undefined);
  }
});

Deno.test("GCash crop never treats unrelated rows or absent masked phone as complete evidence", () => {
  for (
    const text of [
      "KR••••E L•• C.",
      "+63 9•••••2169",
      cropText + "\nOTHER PERSON",
      "KR••••E L•• C.\n+63 92169",
      "K. L. C.\n+63 9•••••2169",
    ]
  ) {
    const result = refineGcashRecipient(primary(), {
      native: observation(text),
      enlarged: observation(text),
    });
    assertEquals(result.accepted, false);
    assertEquals(
      ["crop_recipient_incomplete", "crop_confidence_insufficient"].includes(
        result.reason,
      ),
      true,
    );
  }
});

Deno.test("GCash recipient crop uses binary native and fourfold color PNG pixels and preserves uploaded bytes", async () => {
  const bytes = await new Image(200, 120).fill(0xffffffff).encode();
  const before = bytes.slice();
  const calls: unknown[] = [];
  const result = await rereadGcashRecipient(
    bytes,
    region,
    primary(),
    "test-key",
    {
      ocr: async (key, encoded, options) => {
        const decoded = Uint8Array.from(
          atob(encoded),
          (character) => character.charCodeAt(0),
        );
        calls.push({
          key,
          dimensions: receiptImageDimensions(decoded),
          options: { featureType: options?.featureType },
        });
        assertEquals(
          (options?.timeoutMs ?? 0) > 0 && (options?.timeoutMs ?? 0) <= 10000,
          true,
          "shared deadline includes preparation time",
        );
        return observation();
      },
    },
  );
  assertEquals(calls, [
    {
      key: "test-key",
      dimensions: { width: 160, height: 60 },
      options: { featureType: "DOCUMENT_TEXT_DETECTION" },
    },
    {
      key: "test-key",
      dimensions: { width: 640, height: 240 },
      options: { featureType: "DOCUMENT_TEXT_DETECTION" },
    },
  ]);
  assertEquals(result.accepted, true);
  assertEquals(result.region, region);
  assertEquals(bytes, before);
});

Deno.test("GCash crop retains low whole-image confidence while using native visible-character scores", () => {
  const result = refineGcashRecipient(primary(), {
    native: { ...observation(), confidence: 0.65 },
    enlarged: { ...observation(), confidence: 0.74 },
  });
  assertEquals(result.accepted, true);
  assertEquals(result.confidence, 0.97);
  assertEquals(result.observations.map((o) => o.confidence), [0.65, 0.74]);
  const missingSource = observation();
  missingSource.recipientCropEvidence.confidenceSource = "none" as never;
  assertEquals(
    refineGcashRecipient(primary(), {
      native: observation(),
      enlarged: missingSource,
    }).accepted,
    false,
  );
});

Deno.test("GCash mask positions cannot shift across optical views or contradict existing masks", () => {
  const native = observation("KR••••E L•• C.\n+63 9***12169");
  const enlarged = observation("KR••••E L•• C.\n+63 91***2169");
  const original = primary("KRE L. C.", "+63 9***12169");
  const disagreed = refineGcashRecipient(original, { native, enlarged });
  assertEquals(disagreed.accepted, false);
  assertEquals(disagreed.reason, "crop_recipients_disagree");
  const movedName = observation("K••••RE L•• C.\n+63 9•••••2169");
  const changed = refineGcashRecipient(primary("KR••••E L•• C."), {
    native: movedName,
    enlarged: movedName,
  });
  assertEquals(changed.accepted, false);
  assertEquals(changed.reason, "crop_name_changed");
});

Deno.test("GCash unsafe crop geometry never calls OCR", async () => {
  const bytes = await new Image(200, 120).fill(0xffffffff).encode();
  assertEquals(
    validGcashRecipientCrop(region, { width: 200, height: 120 }),
    true,
  );
  let calls = 0;
  for (
    const box of [undefined, { ...region, x: -1 }, { ...region, x: 50 }, {
      ...region,
      x: 0.5,
    }, { ...region, width: 1500, height: 1000 }]
  ) {
    const result = await rereadGcashRecipient(
      bytes,
      box,
      primary(),
      "test-key",
      {
        ocr: async () => {
          calls++;
          throw new Error("must not execute");
        },
      },
    );
    assertEquals(result.accepted, false);
    assertEquals(result.attempted, false);
    assertEquals(result.reason, "recipient_region_unavailable");
  }
  assertEquals(calls, 0);
});

Deno.test("GCash incomplete OCR retry cannot replace original recipient evidence", async () => {
  const bytes = await new Image(200, 120).fill(0xffffffff).encode();
  const original = primary();
  let calls = 0;
  const result = await rereadGcashRecipient(
    bytes,
    region,
    original,
    "test-key",
    {
      ocr: async () => {
        if (++calls === 2) throw new Error("timed out");
        return observation();
      },
    },
  );
  assertEquals(calls, 2);
  assertEquals(result.accepted, false);
  assertEquals(result.attempted, true);
  assertEquals(result.reason, "recipient_reread_failed");
  assertEquals(result.receiver, original.receiver);
});
