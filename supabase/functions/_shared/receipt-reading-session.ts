import {
  googleVisionOcr,
  type GoogleVisionRequestMetrics,
} from "./google-vision.ts";

/** A request-scoped budget shared by the original read and all recovery views. */
export function createReceiptReadingSession(options: {
  ocr?: typeof googleVisionOcr;
  now?: () => number;
  budgetMs?: number;
} = {}) {
  const now = options.now || Date.now;
  const startedAt = now();
  const budgetMs = Math.min(55_000, Math.max(1, options.budgetMs ?? 50_000));
  let calls = 0;
  let retries = 0;
  const account = (value: unknown) => {
    const metrics = (value as { requestMetrics?: GoogleVisionRequestMetrics })
      ?.requestMetrics;
    if (!metrics) return;
    if (Number.isSafeInteger(metrics.calls) && metrics.calls >= 0) {
      calls += metrics.calls;
    }
    if (Number.isSafeInteger(metrics.retries) && metrics.retries >= 0) {
      retries += metrics.retries;
    }
  };
  const remainingMs = () => Math.max(0, budgetMs - (now() - startedAt));
  const ocr: typeof googleVisionOcr = async (key, content, config = {}) => {
    const remaining = remainingMs();
    if (remaining <= 0) {
      throw new Error("Receipt reading time budget exhausted");
    }
    try {
      const result = await (options.ocr || googleVisionOcr)(key, content, {
        ...config,
        timeoutMs: Math.min(remaining, config.timeoutMs ?? 25_000),
      });
      account(result);
      return result;
    } catch (error) {
      account(error);
      throw error;
    }
  };
  return {
    ocr,
    remainingMs,
    metrics: (): GoogleVisionRequestMetrics => ({
      calls,
      retries,
      durationMs: Math.max(0, now() - startedAt),
    }),
  };
}

/** Only stable provider labels determine a family; never names or amounts. */
export function gcashLayoutFamily(text: string): string {
  const words = text.toLowerCase().replace(/\s+/g, " ");
  if (!/sent via gcash/.test(words) || !/total amount sent/.test(words)) {
    return "gcash_unknown";
  }
  return /express send/.test(words)
    ? "gcash_express_send"
    : "gcash_send_money";
}
