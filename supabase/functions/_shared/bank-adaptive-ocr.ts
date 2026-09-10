import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  googleVisionOcr,
  type GoogleVisionOcrResult,
  type GoogleVisionRequestMetrics,
  receiptImageSafeToDecode,
} from "./google-vision.ts";
import {
  type BankApprovalConfidence,
  bankApprovalConfidence,
  bankFieldIdentity,
  bankLayoutFamily,
  bankOcrText,
  type BankProviderParse,
  bankReceiptHasIncompleteStatus,
} from "./bank-ocr-evidence.ts";
import {
  parseProviderReceipt,
  type ReceiptVerificationContext,
  verifyProviderReceipt,
} from "./receipt-providers/index.ts";

export {
  bankApprovalConfidence,
  bankLayoutFamily,
  bankOcrText,
  bankReceiptHasIncompleteStatus,
  isBankAdaptiveProvider,
} from "./bank-ocr-evidence.ts";
export type {
  BankAdaptiveProvider,
  BankApprovalConfidence,
  BankProviderParse,
} from "./bank-ocr-evidence.ts";
export const BANK_RECOVERY_STRATEGIES = [
  "bank_full_contrast_v1",
  "bank_full_enlarged_v1",
] as const;
export type BankRecoveryStrategy = typeof BANK_RECOVERY_STRATEGIES[number];
export type BankRecoveryOriginal = {
  read: GoogleVisionOcrResult;
  parsed: BankProviderParse;
};
export type BankRecoverySelected = BankRecoveryOriginal & {
  strategy: BankRecoveryStrategy;
  approval: BankApprovalConfidence;
};
export type BankRecoveryReading = {
  strategy: BankRecoveryStrategy;
  outcome: "clean" | "uncertain" | "conflict" | "error";
  elapsedMs: number;
  flags: string[];
  confidence?: number;
  requestMetrics?: GoogleVisionRequestMetrics;
  rawText?: string;
  layoutText?: string;
  nativeConfidence?: number;
  confidenceSource?: GoogleVisionOcrResult["confidenceSource"];
  paymentEvidence?: BankApprovalConfidence;
};
export type BankRecoveryResult = {
  accepted: boolean;
  reason: string;
  selected?: BankRecoverySelected;
  audit: {
    version: "bank_adaptive_v1";
    provider: BankProviderParse["provider"];
    destinationProvider: BankProviderParse["destinationProvider"];
    layout: string;
    attempted: boolean;
    accepted: boolean;
    strategy?: BankRecoveryStrategy;
    reason: string;
    preferredStrategy?: BankRecoveryStrategy;
    readings: BankRecoveryReading[];
    elapsedMs: number;
  };
};

function nativeScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= .9 &&
    value <= 1;
}

export function bankOriginalRecoveryVeto(
  original: BankRecoveryOriginal,
  context: ReceiptVerificationContext,
): string[] {
  if (
    bankReceiptHasIncompleteStatus(original.read.text) ||
    bankReceiptHasIncompleteStatus(bankOcrText(original.read))
  ) return ["PAYMENT_STATUS_NOT_COMPLETED"];
  if (original.parsed.receipt.indicators.competingProviderBrand) {
    return ["COMPETING_PROVIDER"];
  }
  const verification = verifyProviderReceipt(original.parsed, context);
  const evidence = bankApprovalConfidence(
    original.read,
    original.parsed,
    context,
  );
  const trusted = (key: string) =>
    nativeScore(evidence.fields[key]?.confidence) ||
    evidence.fields[key]?.occurrenceConfidences?.some(nativeScore);
  return verification.flags.filter((flag) => {
    if (
      flag === "PRICING_UNAVAILABLE" || flag === "REF_FORMAT_INVALID" ||
      /DUPLICATE/.test(flag)
    ) return true;
    if (flag === "REF_MISMATCH") return trusted("reference");
    if (/AMOUNT_MISMATCH|TOTAL_MISMATCH|AMOUNT_REVIEW/.test(flag)) {
      return trusted("amount");
    }
    if (["DATE_NOT_TODAY", "TIME_FUTURE", "TIME_EXPIRED"].includes(flag)) {
      return trusted("dateTime");
    }
    if (/NAME_MISMATCH|RECIPIENT_MISMATCH/.test(flag)) {
      return trusted("recipientName");
    }
    if (/ACCOUNT_MISMATCH|NUMBER_MISMATCH|WRONG_GCASH_NUMBER/.test(flag)) {
      return trusted("recipientAccount");
    }
    return false;
  });
}

export function bankRecoveryConservationFlags(
  original: BankRecoveryOriginal,
  candidate: BankRecoverySelected,
  context: ReceiptVerificationContext,
): string[] {
  const primary = bankApprovalConfidence(
    original.read,
    original.parsed,
    context,
  );
  const flags: string[] = [];
  const candidateFields = candidate.approval.fields;
  for (const [key, field] of Object.entries(primary.fields)) {
    const trusted = nativeScore(field.confidence) ||
      field.occurrenceConfidences?.some(nativeScore) ||
      (!original.read.nativeLines?.length &&
        original.read.confidenceSource === "native" &&
        nativeScore(original.read.confidence));
    if (!trusted || !field.text) continue;
    // Timestamps may be rendered with a different month/date grammar, but the
    // exact observed instant (even within the allowed window) is conserved.
    if (key === "dateTime" && original.parsed.receipt.timestamp.instant) {
      if (
        original.parsed.receipt.timestamp.instant !==
          candidate.parsed.receipt.timestamp.instant
      ) flags.push("ORIGINAL_TIMESTAMP_CONFLICT");
      continue;
    }
    if (
      !candidateFields[key]?.text ||
      bankFieldIdentity(key, field.text) !==
        bankFieldIdentity(key, candidateFields[key].text)
    ) {
      flags.push(
        `ORIGINAL_${
          key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
        }_CONFLICT`,
      );
    }
  }
  return [...new Set(flags)];
}

function signature(candidate: BankRecoverySelected): string {
  const fields = candidate.approval.fields;
  return JSON.stringify({
    provider: candidate.parsed.provider,
    destination: candidate.parsed.destinationProvider,
    reference: candidate.parsed.receipt.reference.value,
    amount: candidate.parsed.receipt.amount.amount,
    instant: candidate.parsed.receipt.timestamp.instant,
    // Each display, fee, secondary ID, status and visible recipient must agree.
    fields: Object.keys(fields).filter((key) => key !== "dateTime").sort().map((
      key,
    ) => [key, bankFieldIdentity(key, fields[key].text)]),
  });
}

export function evaluateBankRecoveryRead(
  strategy: BankRecoveryStrategy,
  read: GoogleVisionOcrResult,
  original: BankRecoveryOriginal,
  context: ReceiptVerificationContext,
): { selected: BankRecoverySelected; reading: BankRecoveryReading } {
  const parsed = parseProviderReceipt(
    original.parsed.provider,
    bankOcrText(read),
    { typedReference: context.typedReference },
  ) as BankProviderParse;
  const approval = bankApprovalConfidence(read, parsed, context);
  const selected = { strategy, read, parsed, approval };
  const flags = [...verifyProviderReceipt(parsed, context).flags];
  const originalLayout = bankLayoutFamily(
    original.parsed.provider,
    bankOcrText(original.read),
  );
  if (bankLayoutFamily(parsed.provider, bankOcrText(read)) !== originalLayout) {
    flags.push("RECEIPT_LAYOUT_CHANGED");
  }
  if (
    approval.source !== "bank_payment_fields" || !approval.complete ||
    !nativeScore(approval.confidence)
  ) flags.push("PAYMENT_FIELD_CONFIDENCE_INCOMPLETE");
  const vetoes = bankOriginalRecoveryVeto({ read, parsed }, context);
  const conservation = bankRecoveryConservationFlags(
    original,
    selected,
    context,
  );
  flags.push(...vetoes, ...conservation);
  return {
    selected,
    reading: {
      strategy,
      outcome: vetoes.length || conservation.length
        ? "conflict"
        : flags.length
        ? "uncertain"
        : "clean",
      flags: [...new Set(flags)],
      elapsedMs: read.requestMetrics?.durationMs ?? 0,
      confidence: approval.confidence,
      ...(read.requestMetrics ? { requestMetrics: read.requestMetrics } : {}),
      rawText: read.text.slice(0, 20000),
      layoutText: bankOcrText(read).slice(0, 20000),
      nativeConfidence: read.confidence,
      confidenceSource: read.confidenceSource,
      paymentEvidence: approval,
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

/** Both full images include every status/destination/fee; majority never overrides
 * a known mismatch. Caller retains duplicate lookup and atomic finalization. */
export async function recoverBankReceipt(
  bytes: Uint8Array,
  original: BankRecoveryOriginal,
  context: ReceiptVerificationContext,
  visionKey: string,
  options: {
    preferredStrategy?: string | null;
    ocr?: typeof googleVisionOcr;
    deadlineMs?: number;
  } = {},
): Promise<BankRecoveryResult> {
  const started = Date.now();
  const deadlineMs = Math.min(12000, Math.max(1, options.deadlineMs ?? 10000));
  const preferredStrategy = BANK_RECOVERY_STRATEGIES.find((id) =>
    id === options.preferredStrategy
  );
  const readings: BankRecoveryReading[] = [];
  const layout = bankLayoutFamily(
    original.parsed.provider,
    bankOcrText(original.read),
  );
  const result = (
    reason: string,
    selected?: BankRecoverySelected,
  ): BankRecoveryResult => ({
    accepted: !!selected,
    reason,
    ...(selected ? { selected } : {}),
    audit: {
      version: "bank_adaptive_v1",
      provider: original.parsed.provider,
      destinationProvider: original.parsed.destinationProvider,
      layout,
      attempted: readings.length > 0,
      accepted: !!selected,
      ...(selected ? { strategy: selected.strategy } : {}),
      reason,
      ...(preferredStrategy ? { preferredStrategy } : {}),
      readings,
      elapsedMs: Date.now() - started,
    },
  });
  const veto = bankOriginalRecoveryVeto(original, context);
  if (veto.length) return result(`original_conflict:${veto.join(",")}`);
  const originalApproval = bankApprovalConfidence(
    original.read,
    original.parsed,
    context,
  );
  if (
    !verifyProviderReceipt(original.parsed, context).flags.length &&
    originalApproval.source !== "none" &&
    nativeScore(originalApproval.confidence)
  ) return result("original_complete");
  if (layout === "unknown") return result("recovery_layout_unavailable");
  if (
    !visionKey || !receiptImageSafeToDecode(bytes, undefined, 8_000_000, 4096)
  ) return result("recovery_image_unavailable");
  let prepared: Record<BankRecoveryStrategy, Uint8Array>;
  try {
    const image = await Image.decode(bytes);
    // Original bank downloads can exceed 2 MP (for example 1206 x 2567).
    // Derive each view directly from the original pixels: shrinking a shared
    // base before enlarging it would discard small account/reference strokes.
    // Keep the full receipt in 2 MP contrast / 4 MP color output budgets.
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
    for (let offset = 0; offset < contrast.bitmap.length; offset += 4) {
      const bitmap = contrast.bitmap;
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
    // Large (>4 MP) originals are downsampled once to the color bound; small
    // originals keep the existing 1.5x enlargement. The color view remains
    // larger than the contrast view in both cases.
    const enlarged = image.resize(colorWidth, colorHeight);
    prepared = {
      bank_full_contrast_v1: await contrast.encode(1),
      bank_full_enlarged_v1: await enlarged.encode(1),
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
  const strategies = [...BANK_RECOVERY_STRATEGIES].sort((a, b) =>
    a === preferredStrategy ? -1 : b === preferredStrategy ? 1 : 0
  );
  const candidates = await Promise.all(strategies.map(async (strategy) => {
    const readingStarted = Date.now();
    try {
      const read = await ocr(visionKey, toBase64(prepared[strategy]), {
        featureType: "DOCUMENT_TEXT_DETECTION",
        timeoutMs: remaining,
      });
      const evaluated = evaluateBankRecoveryRead(
        strategy,
        read,
        original,
        context,
      );
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
  if (clean.length !== 2) {
    return result(
      candidates.some((candidate) => candidate.reading.outcome === "error")
        ? "transport_unavailable"
        : "recovery_incomplete",
    );
  }
  if (signature(clean[0].selected!) !== signature(clean[1].selected!)) {
    return result("recovery_readings_disagree");
  }
  const chosen =
    clean.find((candidate) =>
      candidate.selected!.strategy === preferredStrategy
    ) || [...clean].sort((a, b) =>
      b.selected!.approval.confidence - a.selected!.approval.confidence
    )[0];
  return result("full_readings_agree", {
    ...chosen.selected!,
    approval: {
      ...chosen.selected!.approval,
      confidence: Math.min(
        ...clean.map((candidate) => candidate.selected!.approval.confidence),
      ),
    },
  });
}
