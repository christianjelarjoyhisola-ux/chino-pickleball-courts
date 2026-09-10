import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  type GcashReceiptParse,
  type GcashReceiver,
  parseGcashRecipientBlock,
} from "./gcash-receipt.ts";
import {
  googleVisionOcr,
  type GoogleVisionOcrResult,
  receiptImageDimensions,
  type ReceiptImageRegion,
  receiptImageSafeToDecode,
} from "./google-vision.ts";

type CropObservation = Pick<
  GoogleVisionOcrResult,
  | "text"
  | "layoutText"
  | "confidence"
  | "confidenceSource"
  | "recipientCropEvidence"
>;

export type GcashRecipientOcrObservation = CropObservation & {
  view: "native" | "enlarged";
  receiver: GcashReceiver;
};

export type GcashRecipientOcrResult = {
  attempted: boolean;
  accepted: boolean;
  changed: boolean;
  reason: string;
  receiver: GcashReceiver;
  primaryReceiver: GcashReceiver;
  confidence?: number;
  observations: GcashRecipientOcrObservation[];
  region: ReceiptImageRegion | null;
};

function normalizedName(value: string | null): string {
  return String(value || "").normalize("NFKC").toUpperCase()
    .replace(/[•‣●◦∙·*#]+|\.{2,}|[X]{2,}/g, "*")
    .replace(/[^A-Z*\s]/g, "").replace(/\s+/g, " ").trim();
}

function visibleName(value: string | null): string {
  return normalizedName(value).replace(/\*/g, "");
}

function visiblePhone(value: string | null): string {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("63")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

function normalizedPhone(value: string | null): string {
  let pattern = String(value || "").normalize("NFKC").replace(/[\s()+-]/g, "")
    .replace(/[•‣●◦∙·*#xX.]+/g, "*");
  if (pattern.startsWith("63")) pattern = pattern.slice(2);
  if (pattern.startsWith("0")) pattern = pattern.slice(1);
  return pattern;
}

function auditObservation(
  view: GcashRecipientOcrObservation["view"],
  input: CropObservation,
): GcashRecipientOcrObservation {
  return {
    view,
    text: input?.text || "",
    ...(input?.layoutText ? { layoutText: input.layoutText } : {}),
    confidence: input?.confidence,
    confidenceSource: input?.confidenceSource,
    ...(input?.recipientCropEvidence
      ? { recipientCropEvidence: input.recipientCropEvidence }
      : {}),
    receiver: parseGcashRecipientBlock(input?.layoutText || input?.text || ""),
  };
}

function nativeIdentityConfidence(
  observation: GcashRecipientOcrObservation,
): number | null {
  const evidence = observation.recipientCropEvidence;
  if (
    !evidence || evidence.confidenceSource !== "native" ||
    evidence.basis !== "visible_character_symbols"
  ) return null;
  const values = [
    evidence.name.confidence,
    evidence.phone.confidence,
    evidence.confidence,
  ];
  if (
    values.some((value) =>
      typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      value > 1
    )
  ) return null;
  if (
    normalizedName(evidence.name.text) !==
      normalizedName(observation.receiver.name.raw) ||
    visiblePhone(evidence.phone.text) !==
      visiblePhone(observation.receiver.phone.raw)
  ) return null;
  return Math.min(...values as number[]);
}

function completeCrop(observation: GcashRecipientOcrObservation): boolean {
  const { receiver } = observation;
  const lines = (observation.layoutText || observation.text).split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean);
  // The proven ROI encloses precisely the name and phone. Extra unrelated
  // alphanumeric rows or duplicate candidates cannot become a recipient read.
  if (lines.length !== 2) return false;
  return receiver.name.raw !== null && receiver.phone.raw !== null &&
    receiver.name.lineIndex === 0 && receiver.phone.lineIndex === 1 &&
    receiver.phone.last4 !== null &&
    visibleName(receiver.name.raw).replace(/\s/g, "").length >= 4 &&
    (receiver.phone.visibility === "full" ||
      (receiver.phone.visibility === "masked" &&
        /[•‣●◦∙·*#]|\.{2,}|[xX]{2,}/.test(receiver.phone.raw)));
}

/**
 * Require two optical views to agree before restoring lost mask glyphs. The
 * configured recipient is deliberately not an input. The original receipt's
 * visible letters and digits cannot be changed by a targeted reread.
 */
export function refineGcashRecipient(
  primary: GcashReceiptParse,
  crops: { native: CropObservation; enlarged: CropObservation },
): GcashRecipientOcrResult {
  const observations = [
    auditObservation("native", crops.native),
    auditObservation("enlarged", crops.enlarged),
  ];
  const base: GcashRecipientOcrResult = {
    attempted: true,
    accepted: false,
    changed: false,
    reason: "primary_recipient_incomplete",
    receiver: structuredClone(primary.receiver),
    primaryReceiver: structuredClone(primary.receiver),
    observations,
    region: null,
  };
  const reject = (reason: string) => ({ ...base, reason });
  if (
    primary.provider !== "gcash" ||
    primary.indicators.classification !== "gcash" ||
    !primary.indicators.sentViaGcash || !primary.receiver.name.raw ||
    !primary.receiver.phone.raw || !primary.receiver.phone.last4
  ) return reject("primary_recipient_incomplete");
  if (
    observations.some((entry) =>
      entry.confidenceSource !== "native" ||
      !Number.isFinite(entry.confidence) || entry.confidence < 0 ||
      entry.confidence > 1 || (nativeIdentityConfidence(entry) ?? 0) < 0.9
    )
  ) return reject("crop_confidence_insufficient");
  if (!observations.every(completeCrop)) {
    return reject("crop_recipient_incomplete");
  }
  const [native, enlarged] = observations.map((entry) => entry.receiver);
  if (
    normalizedName(native.name.raw) !== normalizedName(enlarged.name.raw) ||
    native.phone.visibility !== enlarged.phone.visibility ||
    normalizedPhone(native.phone.raw) !== normalizedPhone(enlarged.phone.raw)
  ) return reject("crop_recipients_disagree");
  if (
    visibleName(primary.receiver.name.raw) !== visibleName(native.name.raw) ||
    (normalizedName(primary.receiver.name.raw).includes("*") &&
      normalizedName(primary.receiver.name.raw) !==
        normalizedName(native.name.raw))
  ) return reject("crop_name_changed");
  if (
    primary.receiver.phone.last4 !== native.phone.last4 ||
    visiblePhone(primary.receiver.phone.raw) !==
      visiblePhone(native.phone.raw) ||
    (normalizedPhone(primary.receiver.phone.raw).includes("*") &&
      normalizedPhone(primary.receiver.phone.raw) !==
        normalizedPhone(native.phone.raw)) ||
    (primary.receiver.phone.visibility === "full" &&
      (native.phone.visibility !== "full" ||
        primary.receiver.phone.normalized !== native.phone.normalized))
  ) return reject("crop_phone_changed");
  const changed = normalizedName(primary.receiver.name.raw) !==
      normalizedName(native.name.raw) ||
    primary.receiver.phone.raw !== native.phone.raw;
  return {
    ...base,
    accepted: true,
    changed,
    reason: changed ? "optical_agreement" : "unchanged",
    confidence: Math.min(
      ...observations.map((entry) => nativeIdentityConfidence(entry)!),
    ),
    receiver: {
      name: { ...native.name, lineIndex: primary.receiver.name.lineIndex },
      phone: { ...native.phone, lineIndex: primary.receiver.phone.lineIndex },
    },
  };
}

export function validGcashRecipientCrop(
  region: ReceiptImageRegion | undefined,
  image: { width: number; height: number } | null,
): region is ReceiptImageRegion {
  if (!region || !image) return false;
  const { x, y, width, height } = region;
  return [x, y, width, height].every(Number.isSafeInteger) &&
    x >= 0 && y >= 0 && width >= 32 && height >= 32 &&
    x + width <= image.width && y + height <= image.height &&
    width * height <= 512 * 1024 && width * 4 <= 4096 && height * 4 <= 4096;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Crop OCR receives uploaded image pixels only, with no expected receipt data. */
export async function rereadGcashRecipient(
  bytes: Uint8Array,
  region: ReceiptImageRegion | undefined,
  primary: GcashReceiptParse,
  visionKey: string,
  options: { ocr?: typeof googleVisionOcr } = {},
): Promise<GcashRecipientOcrResult> {
  const unchanged = (reason: string): GcashRecipientOcrResult => ({
    attempted: false,
    accepted: false,
    changed: false,
    reason,
    receiver: structuredClone(primary.receiver),
    primaryReceiver: structuredClone(primary.receiver),
    observations: [],
    region: region || null,
  });
  if (!visionKey || primary.provider !== "gcash") {
    return unchanged("refinement_unavailable");
  }
  if (
    !receiptImageSafeToDecode(bytes, undefined, 8 * 1024 * 1024) ||
    !validGcashRecipientCrop(region, receiptImageDimensions(bytes))
  ) return unchanged("recipient_region_unavailable");
  try {
    const image = await Image.decode(bytes);
    const crop = image.crop(region.x, region.y, region.width, region.height);
    // A contrast-only view retains the positions of the actual round mask
    // glyphs; the separate enlarged color view independently corroborates them.
    const binary = crop.clone();
    for (let y = 1; y <= binary.height; y++) {
      for (let x = 1; x <= binary.width; x++) {
        const [red, green, blue] = Image.colorToRGBA(binary.getPixelAt(x, y));
        binary.setPixelAt(
          x,
          y,
          (red + green + blue) / 3 < 150 ? 0x000000ff : 0xffffffff,
        );
      }
    }
    const nativePng = await binary.encode(1);
    const enlargedPng = await crop.clone().resize(
      region.width * 4,
      region.height * 4,
    ).encode(1);
    if (
      nativePng.length > 2 * 1024 * 1024 || enlargedPng.length > 2 * 1024 * 1024
    ) {
      return unchanged("recipient_crop_too_large");
    }
    const ocr = options.ocr || googleVisionOcr;
    const native = await ocr(visionKey, base64(nativePng), {
      featureType: "DOCUMENT_TEXT_DETECTION",
      timeoutMs: 10_000,
    });
    const enlarged = await ocr(visionKey, base64(enlargedPng), {
      featureType: "DOCUMENT_TEXT_DETECTION",
      timeoutMs: 10_000,
    });
    return { ...refineGcashRecipient(primary, { native, enlarged }), region };
  } catch {
    return { ...unchanged("recipient_reread_failed"), attempted: true };
  }
}
