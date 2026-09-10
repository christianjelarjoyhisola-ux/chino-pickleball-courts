import { createReceiptReadingSession, gcashLayoutFamily } from "./receipt-reading-session.ts";
import type { googleVisionOcr } from "./google-vision.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

Deno.test("receipt reading budget counts real retries and limits the next read", async () => {
  let clock = 100;
  const deadlines: number[] = [];
  const ocr: typeof googleVisionOcr = async (_key, _content, options) => {
    deadlines.push(options!.timeoutMs!);
    clock += 40;
    return {
      text: "observed", confidence: .91, confidenceSource: "native",
      requestMetrics: { calls: 2, retries: 1, durationMs: 40 },
    };
  };
  const session = createReceiptReadingSession({ ocr, now: () => clock, budgetMs: 100 });
  await session.ocr("key", "pixels", { timeoutMs: 80 });
  await session.ocr("key", "pixels", { timeoutMs: 80 });
  equal(deadlines, [80, 60]);
  equal(session.metrics(), { calls: 4, retries: 2, durationMs: 80 });
  clock += 30;
  let rejected = false;
  try { await session.ocr("key", "pixels"); } catch { rejected = true; }
  equal(rejected, true);
  equal(deadlines.length, 2);
});

Deno.test("failed reads contribute actual calls without creating OCR results", async () => {
  const error = Object.assign(new Error("Service unavailable"), {
    requestMetrics: { calls: 2, retries: 1, durationMs: 12 },
  });
  const session = createReceiptReadingSession({
    now: () => 0,
    ocr: () => Promise.reject(error),
  });
  try { await session.ocr("key", "pixels"); } catch (observed) { equal(observed === error, true); }
  equal(session.metrics(), { calls: 2, retries: 1, durationMs: 0 });
});

Deno.test("layout families contain no payment values and require provider anchors", () => {
  equal(gcashLayoutFamily("Express Send\nKR***E L** C\nSent via GCash\nTotal Amount Sent 1590"), "gcash_express_send");
  equal(gcashLayoutFamily("Express Send\nAnother Name\nSent via GCash\nTotal Amount Sent 265"), "gcash_express_send");
  equal(gcashLayoutFamily("Sent via GCash\nTotal Amount Sent"), "gcash_send_money");
  equal(gcashLayoutFamily("Express Send\nBank transfer Processing"), "gcash_unknown");
});
