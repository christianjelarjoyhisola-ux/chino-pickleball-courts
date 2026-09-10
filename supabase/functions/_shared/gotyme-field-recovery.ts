import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  type GoogleVisionNativeLine,
  googleVisionOcr,
  type GoogleVisionOcrResult,
  receiptImageDimensions,
  type ReceiptImageRegion,
  receiptImageSafeToDecode,
} from "./google-vision.ts";
import {
  bankApprovalConfidence,
  bankFieldIdentity,
  bankLayoutFamily,
  bankOcrText,
  type BankProviderParse,
  bankReceiptHasIncompleteStatus,
} from "./bank-ocr-evidence.ts";
import {
  bankOriginalRecoveryVeto,
  bankRecoveryConservationFlags,
  type BankRecoveryOriginal,
  type BankRecoverySelected,
} from "./bank-adaptive-ocr.ts";
import {
  parseProviderReceipt,
  type ReceiptVerificationContext,
  verifyProviderReceipt,
} from "./receipt-providers/index.ts";

type Panel = "recipient" | "amounts";
type View = "contrast" | "enlarged";
export type GotymeFieldReads = Record<
  Panel,
  Record<View, GoogleVisionOcrResult>
>;
type PanelRegion = { region: ReceiptImageRegion; start: number; end: number };
export type GotymeFieldRegions = Record<Panel, PanelRegion>;
export type GotymeFieldRecoveryResult = {
  accepted: boolean;
  reason: string;
  selected?: Omit<BankRecoverySelected, "strategy"> & {
    strategy: "gotyme_field_pair_v1";
  };
  audit: {
    version: "gotyme_fields_v1";
    attempted: boolean;
    accepted: boolean;
    strategy?: "gotyme_field_pair_v1";
    reason: string;
    readings: Array<
      {
        strategy: string;
        outcome: "clean" | "uncertain" | "conflict" | "error";
        flags: string[];
        elapsedMs: number;
        confidence?: number;
        requestMetrics?: GoogleVisionOcrResult["requestMetrics"];
        rawText?: string;
        layoutText?: string;
      }
    >;
    elapsedMs: number;
    regions?: GotymeFieldRegions;
    paymentEvidence?: ReturnType<typeof bankApprovalConfidence>;
  };
};

/** Locate observed To/From and Amount/Fee/Total rows without needing a parsed
 * account. Fragmented masks cannot prevent this bounded optical recovery. */
export function deriveGotymeFieldRegions(
  read: GoogleVisionOcrResult,
  dimensions: { width: number; height: number } | null,
): GotymeFieldRegions | null {
  const lines = read.nativeLines;
  if (
    !dimensions || !lines?.length || lines.some((line) => line.page !== 0) ||
    bankLayoutFamily("gotyme", bankOcrText(read)) !== "gotyme_transferred_v1"
  ) return null;
  const anchor = (pattern: RegExp) => {
    const indexes = lines.map((line, index) =>
      pattern.test(line.text) ? index : -1
    ).filter((index) => index >= 0);
    return indexes.length === 1 ? indexes[0] : -1;
  };
  const to = anchor(/^To\b/i),
    from = anchor(/^From\b/i),
    amount = anchor(/^Amount\b/i),
    fee = anchor(/^Fee\b/i),
    total = anchor(/^Total\b/i),
    trace = anchor(/^Trace\s+ID\b/i);
  if (
    !(to >= 0 && from > to && amount > from && fee > amount && total > fee &&
      trace > total)
  ) return null;
  if (!lines.slice(to, from).some((line) => /\bgcash\b/i.test(line.text))) {
    return null;
  }
  const panel = (start: number, end: number): PanelRegion | null => {
    const words = lines.slice(start, end).flatMap((line) => line.words);
    if (!words.length) return null;
    const heights = words.map((word) => word.bottom - word.top).filter((
      height,
    ) => height > 0).sort((a, b) => a - b);
    const padding = Math.max(
      16,
      Math.min(48, heights[Math.floor(heights.length / 2)] || 24),
    );
    const left = Math.max(
      0,
      Math.floor(Math.min(...words.map((word) => word.left)) - padding),
    );
    const right = Math.min(
      dimensions.width,
      Math.ceil(Math.max(...words.map((word) => word.right)) + padding),
    );
    const priorBottom = start > 0
      ? Math.max(...lines[start - 1].words.map((word) => word.bottom))
      : 0;
    const nextTop = end < lines.length
      ? Math.min(...lines[end].words.map((word) => word.top))
      : dimensions.height;
    const top = Math.max(
      0,
      Math.ceil(priorBottom + 1),
      Math.floor(Math.min(...words.map((word) => word.top)) - padding),
    );
    const bottom = Math.min(
      dimensions.height,
      Math.floor(nextTop - 1),
      Math.ceil(Math.max(...words.map((word) => word.bottom)) + padding),
    );
    const region = {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
    if (
      ![region.x, region.y, region.width, region.height].every(
        Number.isSafeInteger,
      ) || region.width < 32 || region.height < 32 ||
      region.width * region.height > 512 * 1024
    ) return null;
    return { region, start, end };
  };
  const recipient = panel(to, from), amounts = panel(amount, trace);
  return recipient && amounts ? { recipient, amounts } : null;
}

function usablePanel(read: GoogleVisionOcrResult, panel: Panel): boolean {
  if (
    read.confidenceSource !== "native" || !read.nativeLines?.length ||
    read.nativeLines.some((line) => line.page !== 0) ||
    bankReceiptHasIncompleteStatus(read.text) ||
    bankReceiptHasIncompleteStatus(bankOcrText(read))
  ) return false;
  const lines = read.nativeLines.map((line) => line.text);
  if (
    lines.some((line) =>
      /^(?:From|Reference|Trace|Date|Transferred|Transfer\s+successful)\b/i
        .test(line)
    )
  ) return false;
  const count = (pattern: RegExp) =>
    lines.filter((line) => pattern.test(line)).length;
  return panel === "recipient"
    ? count(/^To\b/i) === 1 && count(/\bgcash\b/i) === 1 &&
      count(/^(?:Amount|Fee|Total)\b/i) === 0
    : count(/^Amount\b/i) === 1 && count(/^Fee\b/i) === 1 &&
      count(/^Total\b/i) === 1 && count(/^To\b/i) === 0;
}

function compose(
  original: GoogleVisionOcrResult,
  regions: GotymeFieldRegions,
  recipient: GoogleVisionOcrResult,
  amounts: GoogleVisionOcrResult,
): GoogleVisionOcrResult {
  const source = original.nativeLines!;
  // Each word comes from either the original or one explicitly audited crop.
  // No expected, player-entered, inferred or manually corrected text is added.
  const nativeLines: GoogleVisionNativeLine[] = [
    ...source.slice(0, regions.recipient.start),
    ...recipient.nativeLines!,
    ...source.slice(regions.recipient.end, regions.amounts.start),
    ...amounts.nativeLines!,
    ...source.slice(regions.amounts.end),
  ];
  return {
    ...original,
    layoutText: nativeLines.map((line) => line.text).join("\n"),
    nativeLines,
  };
}

export function evaluateGotymeFieldReads(
  original: BankRecoveryOriginal,
  context: ReceiptVerificationContext,
  regions: GotymeFieldRegions,
  reads: GotymeFieldReads,
): GotymeFieldRecoveryResult {
  const readings: GotymeFieldRecoveryResult["audit"]["readings"] = [];
  const result = (
    reason: string,
    selected?: BankRecoverySelected,
  ): GotymeFieldRecoveryResult => ({
    accepted: !!selected,
    reason,
    ...(selected
      ? { selected: { ...selected, strategy: "gotyme_field_pair_v1" } }
      : {}),
    audit: {
      version: "gotyme_fields_v1",
      attempted: true,
      accepted: !!selected,
      reason,
      readings,
      elapsedMs: 0,
      regions,
      ...(selected
        ? {
          strategy: "gotyme_field_pair_v1",
          paymentEvidence: selected.approval,
        }
        : {}),
    },
  });
  if (original.parsed.provider !== "gotyme") {
    return result("unsupported_provider");
  }
  const veto = bankOriginalRecoveryVeto(original, context);
  if (veto.length) return result(`original_conflict:${veto.join(",")}`);
  for (const panel of ["recipient", "amounts"] as const) {
    for (const view of ["contrast", "enlarged"] as const) {
      const read = reads[panel][view];
      const adverse = bankReceiptHasIncompleteStatus(read.text) ||
        bankReceiptHasIncompleteStatus(bankOcrText(read));
      readings.push({
        strategy: `gotyme_${panel}_${view}_v1`,
        outcome: adverse ? "conflict" : "uncertain",
        flags: adverse
          ? ["PAYMENT_STATUS_NOT_COMPLETED"]
          : usablePanel(read, panel)
          ? []
          : ["TARGETED_PANEL_UNREADABLE"],
        elapsedMs: read.requestMetrics?.durationMs || 0,
        requestMetrics: read.requestMetrics,
        rawText: read.text.slice(0, 12000),
        layoutText: bankOcrText(read).slice(0, 12000),
      });
    }
  }
  if (readings.some((reading) => reading.outcome === "conflict")) {
    return result("recovery_conflict");
  }
  if (readings.some((reading) => reading.flags.length)) {
    return result("targeted_panel_unreadable");
  }
  const candidates = (["contrast", "enlarged"] as const).map((view) => {
    const read = compose(
      original.read,
      regions,
      reads.recipient[view],
      reads.amounts[view],
    );
    const parsed = parseProviderReceipt("gotyme", bankOcrText(read), {
      typedReference: context.typedReference,
    }) as BankProviderParse;
    const approval = bankApprovalConfidence(read, parsed, context);
    const selected: BankRecoverySelected = {
      strategy: view === "contrast"
        ? "bank_full_contrast_v1"
        : "bank_full_enlarged_v1",
      read,
      parsed,
      approval,
    };
    const flags = [...verifyProviderReceipt(parsed, context).flags];
    const conservation = bankRecoveryConservationFlags(
      original,
      selected,
      context,
    );
    const vetoes = bankOriginalRecoveryVeto({ read, parsed }, context);
    const conflicts = [...conservation, ...vetoes];
    // Any failed conservation rejects this candidate. Only an independently
    // trustworthy contradictory value poisons other recovery strategies:
    // a weak "$" glyph that makes Total unreadable cannot erase the original
    // good total, but it also cannot block a later full read preserving it.
    const strongConservation = conservation.filter((flag) => {
      const field = flag === "ORIGINAL_TIMESTAMP_CONFLICT"
        ? approval.fields.dateTime
        : Object.entries(approval.fields).find(([key]) =>
          flag ===
            `ORIGINAL_${
              key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
            }_CONFLICT`
        )?.[1];
      const high = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= .9 &&
        value <= 1;
      return !!field?.text &&
        (high(field.confidence) || field.occurrenceConfidences?.some(high));
    });
    const hardConflict = vetoes.length > 0 || strongConservation.length > 0;
    flags.push(...conflicts);
    if (
      !approval.complete || approval.source !== "bank_payment_fields" ||
      approval.confidence < .9
    ) flags.push("PAYMENT_FIELD_CONFIDENCE_INCOMPLETE");
    for (const panel of ["recipient", "amounts"] as const) {
      const audit = readings.find((reading) =>
        reading.strategy === `gotyme_${panel}_${view}_v1`
      )!;
      audit.flags = [...new Set(flags)];
      audit.outcome = hardConflict
        ? "conflict"
        : flags.length
        ? "uncertain"
        : "clean";
      audit.confidence = approval.confidence;
    }
    return selected;
  });
  if (readings.some((reading) => reading.outcome === "conflict")) {
    return result("recovery_conflict");
  }
  if (readings.some((reading) => reading.outcome !== "clean")) {
    return result("recovery_incomplete");
  }
  const signature = (candidate: BankRecoverySelected) =>
    JSON.stringify(
      Object.entries(candidate.approval.fields).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, field]) => [key, bankFieldIdentity(key, field.text)]),
    );
  if (signature(candidates[0]) !== signature(candidates[1])) {
    return result("recovery_readings_disagree");
  }
  const selected = candidates[1];
  selected.approval = {
    ...selected.approval,
    confidence: Math.min(
      ...candidates.map((candidate) => candidate.approval.confidence),
    ),
  };
  return result("targeted_readings_agree", selected);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function recoverGotymeFields(
  bytes: Uint8Array,
  original: BankRecoveryOriginal,
  context: ReceiptVerificationContext,
  visionKey: string,
  options: { ocr?: typeof googleVisionOcr; deadlineMs?: number } = {},
): Promise<GotymeFieldRecoveryResult> {
  const started = Date.now(),
    deadlineMs = Math.min(12000, Math.max(1, options.deadlineMs ?? 10000));
  const unchanged = (
    reason: string,
    attempted = false,
  ): GotymeFieldRecoveryResult => ({
    accepted: false,
    reason,
    audit: {
      version: "gotyme_fields_v1",
      accepted: false,
      attempted,
      reason,
      readings: [],
      elapsedMs: Date.now() - started,
    },
  });
  if (original.parsed.provider !== "gotyme") {
    return unchanged("unsupported_provider");
  }
  const veto = bankOriginalRecoveryVeto(original, context);
  if (veto.length) return unchanged(`original_conflict:${veto.join(",")}`);
  const approval = bankApprovalConfidence(
    original.read,
    original.parsed,
    context,
  );
  if (
    !verifyProviderReceipt(original.parsed, context).flags.length &&
    approval.confidence >= .9 && approval.source !== "none"
  ) return unchanged("original_complete");
  if (
    !visionKey || !receiptImageSafeToDecode(bytes, undefined, 8_000_000, 4096)
  ) return unchanged("recovery_image_unavailable");
  const regions = deriveGotymeFieldRegions(
    original.read,
    receiptImageDimensions(bytes),
  );
  if (!regions) return unchanged("targeted_region_unavailable");
  const prepared: Array<{ panel: Panel; view: View; bytes: Uint8Array }> = [];
  try {
    const image = await Image.decode(bytes);
    for (const panel of ["recipient", "amounts"] as const) {
      const region = regions[panel].region;
      const crop = image.clone().crop(
        region.x,
        region.y,
        region.width,
        region.height,
      );
      for (const view of ["contrast", "enlarged"] as const) {
        const scale = Math.min(
          view === "contrast" ? 2 : 3,
          Math.sqrt(4_000_000 / (crop.width * crop.height)),
          4096 / crop.width,
          4096 / crop.height,
        );
        const variant = crop.clone().resize(
          Math.floor(crop.width * scale),
          Math.floor(crop.height * scale),
        );
        if (view === "contrast") {
          for (let offset = 0; offset < variant.bitmap.length; offset += 4) {
            const pixels = variant.bitmap, alpha = pixels[offset + 3] / 255;
            const luminance =
              (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3 *
                alpha + 255 * (1 - alpha);
            const value = luminance < 150 ? 0 : 255;
            pixels[offset] = value;
            pixels[offset + 1] = value;
            pixels[offset + 2] = value;
            pixels[offset + 3] = 255;
          }
        }
        const encoded = await variant.encode(1);
        if (encoded.length > 4 * 1024 * 1024) {
          return unchanged("targeted_image_too_large");
        }
        prepared.push({ panel, view, bytes: encoded });
      }
    }
  } catch {
    return unchanged("recovery_image_unavailable");
  }
  const remaining = deadlineMs - (Date.now() - started);
  if (remaining <= 0) return unchanged("recovery_deadline_exceeded");
  const ocr = options.ocr || googleVisionOcr;
  const results = await Promise.allSettled(
    prepared.map(async ({ panel, view, bytes }) => ({
      panel,
      view,
      read: await ocr(visionKey, base64(bytes), {
        featureType: view === "contrast"
          ? "TEXT_DETECTION"
          : "DOCUMENT_TEXT_DETECTION",
        timeoutMs: remaining,
      }),
    })),
  );
  const incomplete = (reason: string): GotymeFieldRecoveryResult => {
    const incompleteResult = unchanged(reason, true);
    incompleteResult.audit.regions = regions;
    incompleteResult.audit.readings = results.map((result, index) => {
      const read = result.status === "fulfilled" ? result.value.read : null;
      const adverse = !!read &&
        (bankReceiptHasIncompleteStatus(read.text) ||
          bankReceiptHasIncompleteStatus(bankOcrText(read)));
      const requestMetrics = read?.requestMetrics ||
        (result.status === "rejected"
          ? result.reason?.requestMetrics
          : undefined);
      return {
        strategy: `gotyme_${prepared[index].panel}_${prepared[index].view}_v1`,
        outcome: adverse
          ? "conflict"
          : result.status === "rejected"
          ? "error"
          : "uncertain",
        flags: adverse
          ? ["PAYMENT_STATUS_NOT_COMPLETED"]
          : result.status === "rejected"
          ? ["OCR_UNAVAILABLE"]
          : [],
        elapsedMs: requestMetrics?.durationMs || 0,
        requestMetrics,
        ...(read
          ? {
            rawText: read.text.slice(0, 12000),
            layoutText: bankOcrText(read).slice(0, 12000),
          }
          : {}),
      };
    });
    // A timeout or another failed panel cannot hide an adverse status that
    // one of the completed optical requests actually observed.
    if (
      incompleteResult.audit.readings.some((reading) =>
        reading.outcome === "conflict"
      )
    ) {
      incompleteResult.reason = "recovery_conflict";
      incompleteResult.audit.reason = "recovery_conflict";
    }
    return incompleteResult;
  };
  if (Date.now() - started > deadlineMs) {
    return incomplete("recovery_deadline_exceeded");
  }
  if (results.some((result) => result.status === "rejected")) {
    return incomplete("transport_unavailable");
  }
  const reads = { recipient: {}, amounts: {} } as GotymeFieldReads;
  for (const result of results) {
    if (result.status === "fulfilled") {
      reads[result.value.panel][result.value.view] = result.value.read;
    }
  }
  const evaluated = evaluateGotymeFieldReads(original, context, regions, reads);
  evaluated.audit.elapsedMs = Date.now() - started;
  return evaluated;
}
