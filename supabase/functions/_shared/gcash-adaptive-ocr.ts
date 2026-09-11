import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  type GcashApprovalConfidence,
  gcashApprovalConfidence,
} from "./gcash-approval-confidence.ts";
import {
  type GcashRecipientOcrResult,
  refineGcashRecipient,
} from "./gcash-recipient-ocr.ts";
import {
  type GoogleVisionGcashEvidence,
  googleVisionOcr,
  type GoogleVisionOcrResult,
  type GoogleVisionRequestMetrics,
  receiptImageSafeToDecode,
} from "./google-vision.ts";
import {
  type GcashProviderReceiptParse,
  parseProviderReceipt,
  type ReceiptVerificationContext,
  verifyProviderReceipt,
} from "./receipt-providers/index.ts";

export const GCASH_RECOVERY_STRATEGIES = [
  "gcash_full_contrast_v1",
  "gcash_full_enlarged_v1",
] as const;
export type GcashRecoveryStrategy = typeof GCASH_RECOVERY_STRATEGIES[number];
export type GcashRecoveryOriginal = {
  read: GoogleVisionOcrResult;
  parsed: GcashProviderReceiptParse;
  refinement?: GcashRecipientOcrResult | null;
};
export type GcashRecoverySelected = {
  strategy: GcashRecoveryStrategy;
  read: GoogleVisionOcrResult;
  parsed: GcashProviderReceiptParse;
  refinement: GcashRecipientOcrResult | null;
  approval: GcashApprovalConfidence;
};
export type GcashRecoveryReading = {
  strategy: GcashRecoveryStrategy;
  outcome: "clean" | "uncertain" | "conflict" | "error" | "skipped";
  elapsedMs: number;
  flags: string[];
  confidence?: number;
  requestMetrics?: GoogleVisionRequestMetrics;
  reusedRecipientEvidence?: boolean;
  rawText?: string;
  layoutText?: string;
  nativeConfidence?: number;
  confidenceSource?: GoogleVisionOcrResult["confidenceSource"];
  gcashEvidence?: GoogleVisionGcashEvidence;
  parsedFields?: Pick<
    GcashProviderReceiptParse["receipt"],
    "reference" | "amount" | "timestamp" | "receiver"
  >;
};
export type GcashRecoveryResult = {
  accepted: boolean;
  reason: string;
  selected?: GcashRecoverySelected;
  audit: {
    version: "gcash_adaptive_v2";
    attempted: boolean;
    accepted: boolean;
    strategy?: GcashRecoveryStrategy;
    reason: string;
    preferredStrategy?: GcashRecoveryStrategy;
    readings: GcashRecoveryReading[];
    elapsedMs: number;
  };
};

function nativeScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.9 &&
    value <= 1;
}

const GCASH_CONFIRMING_READ_MIN_NATIVE_CONFIDENCE = 0.8;

function originalConfirmsCleanReading(
  original: GcashRecoveryOriginal,
  originalVerificationFlags: string[],
  candidate: GcashRecoverySelected,
): boolean {
  return original.read.confidenceSource === "native" &&
    Number.isFinite(original.read.confidence) &&
    original.read.confidence >= GCASH_CONFIRMING_READ_MIN_NATIVE_CONFIDENCE &&
    original.read.confidence <= 1 &&
    originalVerificationFlags.length === 0 &&
    !gcashReceiptHasIncompleteStatus(original.read.text) &&
    signature(original.parsed) === signature(candidate.parsed);
}

export function gcashReceiptHasIncompleteStatus(text: string): boolean {
  return /\b(?:processing|pending|failed|declined|cancelled|canceled|unsuccessful|reversed|refunded)\b/i
    .test(text);
}

/** High-confidence contradictory evidence is never outvoted by retries. */
export function gcashOriginalRecoveryVeto(
  original: GcashRecoveryOriginal,
  context: ReceiptVerificationContext,
): string[] {
  if (gcashReceiptHasIncompleteStatus(original.read.text)) {
    return ["PAYMENT_STATUS_NOT_COMPLETED"];
  }
  if (original.parsed.receipt.indicators.classification === "conflict") {
    return ["COMPETING_PROVIDER"];
  }
  const verification = verifyProviderReceipt(original.parsed, context);
  const fields = original.read.gcashEvidence?.fields;
  const sourceNative = original.read.confidenceSource === "native";
  const score = (key: keyof NonNullable<typeof fields>) =>
    sourceNative && nativeScore(fields?.[key]?.confidence);
  const trustedRecipient = original.refinement?.accepted &&
    nativeScore(original.refinement.confidence);
  const amount = observedCents(fields?.amount?.text);
  const total = observedCents(fields?.totalAmount?.text);
  if (
    score("amount") && score("totalAmount") && amount !== null &&
    total !== null && amount !== total
  ) return ["ORIGINAL_AMOUNT_DISPLAYS_CONFLICT"];
  const vetoes = verification.flags.filter((flag) => {
    if (flag === "PRICING_UNAVAILABLE" || flag === "REF_FORMAT_INVALID") {
      return true;
    }
    if (flag === "REF_MISMATCH") return score("reference");
    if (flag === "AMOUNT_MISMATCH" || flag === "AMOUNT_REVIEW") {
      return score("amount") && score("totalAmount");
    }
    if (["DATE_NOT_TODAY", "TIME_FUTURE", "TIME_EXPIRED"].includes(flag)) {
      return score("dateTime");
    }
    if (flag === "WRONG_GCASH_NUMBER") {
      return !!trustedRecipient || score("recipientPhone");
    }
    if (flag === "RECEIVER_NAME_MISMATCH") {
      return !!trustedRecipient || score("recipientName");
    }
    return false;
  });
  return vetoes;
}

function canonicalName(value: string | null): string {
  return String(value || "").normalize("NFKC").toUpperCase()
    .replace(/[•‣●◦∙·*#]+|\.{2,}|X{2,}/g, "*")
    .replace(/[^A-Z*\s]/g, "").replace(/\s+/g, " ").trim();
}

function canonicalPhone(value: string | null): string {
  let text = String(value || "").normalize("NFKC").replace(/[\s()+-]/g, "")
    .replace(/[•‣●◦∙·*#xX.]+/g, "*");
  if (text.startsWith("63")) text = text.slice(2);
  if (text.startsWith("0")) text = text.slice(1);
  return text;
}

function signature(parsed: GcashProviderReceiptParse): string {
  const receipt = parsed.receipt;
  return JSON.stringify({
    reference: receipt.reference.value,
    amount: Math.round((receipt.amount.amount ?? 0) * 100),
    timestamp: receipt.timestamp.instant,
    phone: canonicalPhone(receipt.receiver.phone.raw),
    name: canonicalName(receipt.receiver.name.raw),
  });
}

function observedCents(value: string | undefined): number | null {
  const compact = String(value || "").replace(/[₱P\s,]/g, "");
  return /^-?\d+\.\d{2}$/.test(compact)
    ? Math.round(Number(compact) * 100)
    : null;
}

/** Successful retry reads cannot rewrite trustworthy original transaction IDs. */
export function gcashRecoveryConservationFlags(
  original: GcashRecoveryOriginal,
  candidate: GcashRecoverySelected,
): string[] {
  if (original.read.confidenceSource !== "native") return [];
  const fields = original.read.gcashEvidence?.fields;
  const primary = original.parsed.receipt;
  const recovered = candidate.parsed.receipt;
  const flags: string[] = [];
  if (
    nativeScore(fields?.reference?.confidence) && primary.reference.value &&
    primary.reference.source === "ref_label" &&
    primary.reference.value !== recovered.reference.value
  ) flags.push("ORIGINAL_REFERENCE_CONFLICT");
  if (
    nativeScore(fields?.dateTime?.confidence) &&
    primary.timestamp.completeness === "date_time" &&
    primary.timestamp.instant !== recovered.timestamp.instant
  ) flags.push("ORIGINAL_TIMESTAMP_CONFLICT");
  for (const key of ["amount", "totalAmount"] as const) {
    const value = observedCents(fields?.[key]?.text);
    if (
      nativeScore(fields?.[key]?.confidence) && value !== null &&
      value !== observedCents(candidate.read.gcashEvidence?.fields[key]?.text)
    ) flags.push("ORIGINAL_AMOUNT_CONFLICT");
  }
  const trustedRefinement = original.refinement?.accepted &&
    nativeScore(original.refinement.confidence);
  if (
    (trustedRefinement || nativeScore(fields?.recipientPhone?.confidence)) &&
    primary.receiver.phone.raw
  ) {
    const originalPhone = canonicalPhone(primary.receiver.phone.raw);
    const candidatePhone = canonicalPhone(recovered.receiver.phone.raw);
    if (
      originalPhone.replace(/\*/g, "") !== candidatePhone.replace(/\*/g, "") ||
      (originalPhone.includes("*") && originalPhone !== candidatePhone) ||
      (primary.receiver.phone.visibility === "full" &&
        (recovered.receiver.phone.visibility !== "full" ||
          primary.receiver.phone.normalized !==
            recovered.receiver.phone.normalized))
    ) flags.push("ORIGINAL_RECIPIENT_PHONE_CONFLICT");
  }
  if (
    (trustedRefinement || nativeScore(fields?.recipientName?.confidence)) &&
    primary.receiver.name.raw
  ) {
    const originalName = canonicalName(primary.receiver.name.raw);
    const candidateName = canonicalName(recovered.receiver.name.raw);
    if (
      originalName.replace(/\*/g, "") !== candidateName.replace(/\*/g, "") ||
      (originalName.includes("*") && originalName !== candidateName) ||
      (primary.receiver.name.visibility === "full" &&
        originalName !== candidateName)
    ) flags.push("ORIGINAL_RECIPIENT_NAME_CONFLICT");
  }
  return [...new Set(flags)];
}

/** Evaluate an actual full OCR result, without using expected values as text. */
export function evaluateGcashRecoveryRead(
  strategy: GcashRecoveryStrategy,
  read: GoogleVisionOcrResult,
  context: ReceiptVerificationContext,
  originalRefinement: GcashRecipientOcrResult | null = null,
): { selected: GcashRecoverySelected; reading: GcashRecoveryReading } {
  const parsed = parseProviderReceipt(
    "gcash",
    read.gcashEvidence?.layoutText || read.text,
    { typedReference: context.typedReference },
  ) as GcashProviderReceiptParse;
  let refinement: GcashRecipientOcrResult | null = null;
  const native = originalRefinement?.observations.find((item) =>
    item.view === "native"
  );
  const enlarged = originalRefinement?.observations.find((item) =>
    item.view === "enlarged"
  );
  if (originalRefinement?.accepted && native && enlarged) {
    // The existing optical pair is reused only if it independently conserves
    // this full reading's visible letters, digits and known mask positions.
    const candidate = refineGcashRecipient(parsed.receipt, {
      native,
      enlarged,
    });
    if (candidate.accepted) {
      refinement = { ...candidate, region: originalRefinement.region };
      parsed.receipt = { ...parsed.receipt, receiver: refinement.receiver };
    }
  }
  const verification = verifyProviderReceipt(parsed, context);
  const flags = [...verification.flags];
  const statusBlocked = gcashReceiptHasIncompleteStatus(read.text);
  if (statusBlocked) flags.push("PAYMENT_STATUS_NOT_COMPLETED");
  const approval = gcashApprovalConfidence(
    read.confidence,
    read.confidenceSource,
    read.gcashEvidence,
    refinement,
  );
  if (
    approval.source !== "gcash_payment_fields" ||
    !nativeScore(approval.confidence)
  ) flags.push("PAYMENT_FIELD_CONFIDENCE_INCOMPLETE");
  const contradiction = gcashOriginalRecoveryVeto(
    { read, parsed, refinement },
    context,
  );
  return {
    selected: { strategy, read, parsed, refinement, approval },
    reading: {
      strategy,
      outcome: contradiction.length
        ? "conflict"
        : flags.length
        ? "uncertain"
        : "clean",
      flags: [...new Set(flags)],
      confidence: approval.confidence,
      elapsedMs: read.requestMetrics?.durationMs ?? 0,
      ...(read.requestMetrics ? { requestMetrics: read.requestMetrics } : {}),
      reusedRecipientEvidence: refinement?.accepted === true,
      rawText: read.text.slice(0, 20000),
      ...(read.gcashEvidence?.layoutText
        ? { layoutText: read.gcashEvidence.layoutText.slice(0, 20000) }
        : {}),
      nativeConfidence: read.confidence,
      confidenceSource: read.confidenceSource,
      ...(read.gcashEvidence
        ? {
          gcashEvidence: {
            ...read.gcashEvidence,
            layoutText: read.gcashEvidence.layoutText.slice(0, 20000),
          },
        }
        : {}),
      parsedFields: {
        reference: parsed.receipt.reference,
        amount: parsed.receipt.amount,
        timestamp: parsed.receipt.timestamp,
        receiver: parsed.receipt.receiver,
      },
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Bounded full-image retry strategies; all account and payment rules stay fixed. */
export async function recoverGcashReceipt(
  bytes: Uint8Array,
  original: GcashRecoveryOriginal,
  context: ReceiptVerificationContext,
  visionKey: string,
  options: {
    preferredStrategy?: string | null;
    ocr?: typeof googleVisionOcr;
    deadlineMs?: number;
  } = {},
): Promise<GcashRecoveryResult> {
  const started = Date.now();
  const deadlineMs = Math.min(12000, Math.max(1, options.deadlineMs ?? 10000));
  const preferredStrategy = GCASH_RECOVERY_STRATEGIES.find((id) =>
    id === options.preferredStrategy
  );
  const readings: GcashRecoveryReading[] = [];
  const result = (
    reason: string,
    selected?: GcashRecoverySelected,
  ): GcashRecoveryResult => ({
    accepted: !!selected,
    reason,
    ...(selected ? { selected } : {}),
    audit: {
      version: "gcash_adaptive_v2",
      attempted: readings.some((item) => item.outcome !== "skipped"),
      accepted: !!selected,
      ...(selected ? { strategy: selected.strategy } : {}),
      reason,
      ...(preferredStrategy ? { preferredStrategy } : {}),
      readings,
      elapsedMs: Date.now() - started,
    },
  });
  const veto = gcashOriginalRecoveryVeto(original, context);
  if (veto.length) return result(`original_conflict:${veto.join(",")}`);
  const originalVerification = verifyProviderReceipt(original.parsed, context);
  const originalApproval = gcashApprovalConfidence(
    original.read.confidence,
    original.read.confidenceSource,
    original.read.gcashEvidence,
    original.refinement || null,
  );
  if (
    !originalVerification.flags.length && originalApproval.source !== "none" &&
    originalApproval.source !== "heuristic" &&
    nativeScore(originalApproval.confidence)
  ) return result("original_complete");
  if (
    !visionKey || !receiptImageSafeToDecode(bytes, undefined, 8_000_000, 4096)
  ) return result("recovery_image_unavailable");
  let prepared: Record<GcashRecoveryStrategy, Uint8Array>;
  try {
    const image = await Image.decode(bytes);
    // Modern phone screenshots commonly exceed 2 MP. Derive both bounded
    // views directly from the uploaded pixels so recovery remains available
    // without double-resizing away small reference or recipient characters.
    const contrast = image.clone();
    const baseScale = Math.min(
      1,
      Math.sqrt(2_000_000 / (image.width * image.height)),
    );
    if (baseScale < 1) {
      contrast.resize(
        Math.max(1, Math.floor(image.width * baseScale)),
        Math.max(1, Math.floor(image.height * baseScale)),
      );
    }
    if (Date.now() - started >= deadlineMs) {
      return result("recovery_deadline_exceeded");
    }
    const bitmap = contrast.bitmap;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      const alpha = bitmap[offset + 3] / 255;
      const luminance =
        ((bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3) *
          alpha + 255 * (1 - alpha);
      const value = luminance < 150 ? 0 : 255;
      bitmap[offset] = value;
      bitmap[offset + 1] = value;
      bitmap[offset + 2] = value;
      bitmap[offset + 3] = 255;
    }
    const scale = Math.min(
      1.5,
      Math.sqrt(4_000_000 / (image.width * image.height)),
      4096 / image.width,
      8192 / image.height,
    );
    const colorWidth = Math.max(1, Math.floor(image.width * scale));
    const colorHeight = Math.max(1, Math.floor(image.height * scale));
    if (colorWidth <= contrast.width && colorHeight <= contrast.height) {
      return result("recovery_enlargement_unavailable");
    }
    const enlarged = image.resize(colorWidth, colorHeight);
    prepared = {
      gcash_full_contrast_v1: await contrast.encode(1),
      gcash_full_enlarged_v1: await enlarged.encode(1),
    };
    if (Object.values(prepared).some((png) => png.length > 4 * 1024 * 1024)) {
      return result("recovery_image_too_large");
    }
  } catch {
    return result("recovery_image_unavailable");
  }
  const remaining = deadlineMs - (Date.now() - started);
  if (remaining <= 0) return result("recovery_deadline_exceeded");
  const ocr = options.ocr || googleVisionOcr;
  const strategies = [...GCASH_RECOVERY_STRATEGIES].sort((a, b) =>
    a === preferredStrategy ? -1 : b === preferredStrategy ? 1 : 0
  );
  const candidates = await Promise.all(strategies.map(async (strategy) => {
    const readingStarted = Date.now();
    try {
      const read = await ocr(visionKey, toBase64(prepared[strategy]), {
        featureType: "DOCUMENT_TEXT_DETECTION",
        timeoutMs: remaining,
      });
      const evaluated = evaluateGcashRecoveryRead(
        strategy,
        read,
        context,
        original.refinement || null,
      );
      const conflicts = gcashRecoveryConservationFlags(
        original,
        evaluated.selected,
      );
      if (conflicts.length) {
        evaluated.reading.flags = [
          ...new Set([...evaluated.reading.flags, ...conflicts]),
        ];
        evaluated.reading.outcome = "conflict";
      }
      evaluated.reading.elapsedMs = Date.now() - readingStarted;
      return evaluated;
    } catch (error) {
      const metrics = (error as { requestMetrics?: GoogleVisionRequestMetrics })
        ?.requestMetrics;
      return {
        selected: null,
        reading: {
          strategy,
          outcome: "error" as const,
          flags: ["OCR_UNAVAILABLE"],
          elapsedMs: Date.now() - readingStarted,
          ...(metrics ? { requestMetrics: metrics } : {}),
        },
      };
    }
  }));
  readings.push(...candidates.map((candidate) => candidate.reading));
  if (Date.now() - started > deadlineMs) {
    return result("recovery_deadline_exceeded");
  }
  if (
    candidates.some((candidate) => candidate.reading.outcome === "conflict")
  ) return result("recovery_conflict");
  const clean = candidates.filter((candidate) =>
    candidate.selected && candidate.reading.outcome === "clean"
  );
  if (clean.length === 1) {
    const selected = clean[0].selected!;
    // A phone screenshot can make the monochrome view lose light-blue labels
    // even when the color/enlarged view has complete native confidence for all
    // six payment fields. Accept that field-complete view only when the native
    // original read independently passes every hard rule and reproduces the
    // exact same reference, amount, timestamp, phone, and masked name.
    if (
      originalConfirmsCleanReading(
        original,
        originalVerification.flags,
        selected,
      )
    ) {
      return result("original_and_field_reading_agree", selected);
    }
  }
  if (clean.length !== 2) return result("recovery_incomplete");
  if (
    signature(clean[0].selected!.parsed) !==
      signature(clean[1].selected!.parsed)
  ) return result("recovery_readings_disagree");
  const chosen =
    clean.find((candidate) =>
      candidate.selected!.strategy === preferredStrategy
    ) || [...clean].sort((a, b) =>
      b.selected!.approval.confidence - a.selected!.approval.confidence
    )[0];
  const selected = {
    ...chosen.selected!,
    approval: {
      confidence: Math.min(
        ...clean.map((candidate) => candidate.selected!.approval.confidence),
      ),
      source: "gcash_payment_fields" as const,
    },
  };
  return result("full_readings_agree", selected);
}
