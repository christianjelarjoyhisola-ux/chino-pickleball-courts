import type { GoogleVisionGcashEvidence } from "./google-vision.ts";
import type { GcashRecipientOcrResult } from "./gcash-recipient-ocr.ts";
import type { GcashReceiptParse } from "./gcash-receipt.ts";

type NativeConfidenceSource = "native" | "heuristic" | "none";

export type GcashApprovalConfidence = {
  confidence: number;
  source: NativeConfidenceSource | "gcash_payment_fields";
};

const PAYMENT_FIELDS = [
  "amount",
  "totalAmount",
  "reference",
  "dateTime",
  "recipientPhone",
  "recipientName",
] as const;

function validConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= 1;
}

function observedAmountCents(value: unknown): number | null {
  const compact = String(value || "").normalize("NFKC")
    .replace(/^(?:PHP|P|₱)\s*/i, "")
    .replace(/[\s,]/g, "");
  if (!/^\d+\.\d{2}$/.test(compact)) return null;
  const amount = Number(compact);
  return Number.isFinite(amount) && amount >= 0
    ? Math.round(amount * 100)
    : null;
}

/**
 * Preserve the parser's two-display rule when flattened OCR loses the
 * label/value association. Google Vision may still locate the Amount and
 * Total Amount Sent fields independently from word geometry. Those two native
 * observations can confirm the parser's reliable amount only when all three
 * values agree; booking pricing is deliberately not an input.
 */
export function confirmGcashAmountDisplays(
  receipt: GcashReceiptParse,
  evidence: GoogleVisionGcashEvidence | undefined,
  ocrSource: NativeConfidenceSource,
): GcashReceiptParse {
  const amount = receipt.amount;
  if (
    amount.matchingPrimaryAmountDisplays ||
    amount.conflictingPrimaryAmounts ||
    amount.amount == null || !amount.reliable || amount.ambiguous ||
    ocrSource !== "native"
  ) return receipt;

  const first = evidence?.fields.amount;
  const total = evidence?.fields.totalAmount;
  if (
    !first?.text.trim() || !total?.text.trim() ||
    !validConfidence(first.confidence) || first.confidence < 0.9 ||
    !validConfidence(total.confidence) || total.confidence < 0.9
  ) return receipt;

  const firstCents = observedAmountCents(first.text);
  const totalCents = observedAmountCents(total.text);
  const parsedCents = Math.round(amount.amount * 100);
  if (
    firstCents === null || totalCents === null ||
    firstCents !== totalCents || firstCents !== parsedCents
  ) return receipt;

  return {
    ...receipt,
    amount: {
      ...amount,
      matchingPrimaryAmountDisplays: true,
      confirmationSource: "google_vision_fields",
    },
  };
}

/** Use observed payment fields only; parsed matches never create confidence. */
export function gcashApprovalConfidence(
  pageConfidence: number,
  pageSource: NativeConfidenceSource,
  evidence: GoogleVisionGcashEvidence | undefined,
  refinement: GcashRecipientOcrResult | null = null,
): GcashApprovalConfidence {
  const cropScores = refinement?.observations.flatMap((observation) => {
    const fields = observation.recipientCropEvidence;
    if (
      observation.confidenceSource !== "native" ||
      fields?.confidenceSource !== "native" ||
      fields.basis !== "visible_character_symbols" ||
      !fields.name.text.trim() || !fields.phone.text.trim() ||
      !validConfidence(fields.name.confidence) ||
      !validConfidence(fields.phone.confidence)
    ) return [];
    return [fields.name.confidence, fields.phone.confidence];
  }) || [];
  const nativeCrop = refinement?.accepted === true &&
      validConfidence(refinement.confidence) && refinement.confidence >= 0.9 &&
      refinement.observations.length === 2 &&
      new Set(refinement.observations.map((observation) => observation.view))
          .size === 2 &&
      cropScores.length === 4 && cropScores.every((score) => score >= 0.9)
    ? Math.min(refinement.confidence, ...cropScores)
    : null;
  // An accepted reread changes the parsed recipient. If its confidence
  // evidence is incomplete, the original page cannot authorize that change.
  if (refinement?.accepted && nativeCrop === null) {
    return { confidence: 0, source: "none" };
  }
  const page = validConfidence(pageConfidence) ? pageConfidence : 0;
  const fallback = {
    confidence: nativeCrop === null ? page : Math.min(page, nativeCrop),
    source: pageSource,
  };
  if (pageSource !== "native" || !evidence) return fallback;

  const scores = PAYMENT_FIELDS.map((field) => {
    if (
      nativeCrop !== null &&
      (field === "recipientPhone" || field === "recipientName")
    ) return nativeCrop;
    const observed = evidence.fields[field];
    return observed?.text.trim() && validConfidence(observed.confidence)
      ? observed.confidence
      : null;
  });
  if (scores.some((score) => score === null)) {
    // Missing geometry may retain the page policy, but it cannot erase a
    // known weak payment field that was successfully located.
    return {
      ...fallback,
      confidence: Math.min(
        fallback.confidence,
        ...scores.filter((score): score is number => score !== null),
      ),
    };
  }
  return {
    confidence: Math.min(...scores as number[]),
    source: "gcash_payment_fields",
  };
}
