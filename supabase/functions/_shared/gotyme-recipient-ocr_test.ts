import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { parseGotymeToGcashReceipt } from "./receipt-providers/gotyme.ts";
import { receiptImageDimensions } from "./google-vision.ts";
import {
  rereadGotymeRecipient,
  validRecipientCrop,
} from "./gotyme-recipient-ocr.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const primary = () =>
  parseGotymeToGcashReceipt(`Transferred
P265.00
InstaPay Instant
To KR****E L** C*
********9W07
G-Xchange, Inc (GCash)
From SENDER
GoTyme Bank
Amount P265.00
Fee P0.00
Total P265.00
Trace ID 941016
Reference No. ITO260909055941016
Date 09 Sep 2026 at 1:59 PM`);
const cropText = "To KR****E L** C*\n********9WO7\nG-Xchange, Inc (GCash)";
const region = { x: 20, y: 30, width: 160, height: 60 };

Deno.test("recipient crop validates full bounds and enlarged memory limits", () => {
  assertEquals(validRecipientCrop(region, { width: 200, height: 120 }), true);
  for (
    const invalid of [
      { ...region, x: -1 },
      { ...region, x: 50 },
      { ...region, y: 70 },
      { ...region, x: 0.5 },
      { ...region, height: 0 },
      { ...region, width: NaN },
      { x: 0, y: 0, width: 1500, height: 1000 },
      { x: 0, y: 0, width: 2500, height: 40 },
    ]
  ) {
    assertEquals(
      validRecipientCrop(invalid, {
        width: invalid.width > 1000 ? 3000 : 200,
        height: invalid.width > 1000 ? 2000 : 120,
      }),
      false,
    );
  }
});

Deno.test("focused OCR uses original-size and doubled PNG pixels without expected payment data", async () => {
  const bytes = await new Image(200, 120).fill(0xffffffff).encode();
  const unchanged = bytes.slice();
  const original = primary();
  const snapshot = structuredClone(original);
  const calls: unknown[] = [];
  const result = await rereadGotymeRecipient(
    bytes,
    region,
    original,
    "test-key",
    {
      ocr: async (key, content, options) => {
        const decoded = Uint8Array.from(
          atob(content),
          (value) => value.charCodeAt(0),
        );
        calls.push({
          key,
          dimensions: receiptImageDimensions(decoded),
          options,
        });
        return { text: cropText, confidence: 0.98, confidenceSource: "native" };
      },
    },
  );
  assertEquals(calls, [
    {
      key: "test-key",
      dimensions: { width: 160, height: 60 },
      options: { featureType: "TEXT_DETECTION", timeoutMs: 10000 },
    },
    {
      key: "test-key",
      dimensions: { width: 320, height: 120 },
      options: { featureType: "TEXT_DETECTION", timeoutMs: 10000 },
    },
  ]);
  assertEquals(result.accepted, true);
  assertEquals(result.changed, true);
  assertEquals(result.recipient.accountSuffix, "9WO7");
  assertEquals(original, snapshot);
  assertEquals(bytes, unchanged);
});

Deno.test("unsafe or missing crop geometry never calls OCR", async () => {
  const bytes = await new Image(200, 120).fill(0xffffffff).encode();
  let calls = 0;
  for (const box of [undefined, { ...region, x: 100 }]) {
    const result = await rereadGotymeRecipient(
      bytes,
      box,
      primary(),
      "test-key",
      {
        ocr: async () => {
          calls++;
          throw new Error("should not run");
        },
      },
    );
    assertEquals(result.attempted, false);
    assertEquals(result.accepted, false);
    assertEquals(result.recipient.accountSuffix, "9W07");
  }
  assertEquals(calls, 0);
});

Deno.test("one successful crop followed by a timeout cannot change receipt evidence", async () => {
  const bytes = await new Image(200, 120).fill(0xffffffff).encode();
  let calls = 0;
  const original = primary();
  const result = await rereadGotymeRecipient(
    bytes,
    region,
    original,
    "test-key",
    {
      ocr: async () => {
        if (++calls === 2) throw new Error("Google Vision request timed out");
        return { text: cropText, confidence: 0.98, confidenceSource: "native" };
      },
    },
  );
  assertEquals(calls, 2);
  assertEquals(result.accepted, false);
  assertEquals(result.recipient, original.recipient);
  assertEquals(result.reason, "recipient_reread_failed");
});
