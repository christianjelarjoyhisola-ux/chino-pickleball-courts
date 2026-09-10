import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  googleVisionOcr,
  type GoogleVisionOcrResult,
  receiptImageDimensions,
  receiptImageSafeToDecode,
} from "./google-vision.ts";
import { refineGotymeRecipient } from "./gotyme-recipient-refinement.ts";
import type { BankToGcashReceiptParse } from "./receipt-providers/bank-to-gcash.ts";

export type RecipientOcrRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function validRecipientCrop(
  region: RecipientOcrRegion | undefined,
  image: { width: number; height: number } | null,
): region is RecipientOcrRegion {
  if (!region || !image) return false;
  const { x, y, width, height } = region;
  return [x, y, width, height].every(Number.isSafeInteger) &&
    x >= 0 && y >= 0 && width >= 32 && height >= 32 &&
    x + width <= image.width && y + height <= image.height &&
    width * height <= 512 * 1024 &&
    width * 2 <= 4096 && height * 2 <= 4096;
}

/** Optical rereads receive image pixels only, never the configured recipient. */
export async function rereadGotymeRecipient(
  bytes: Uint8Array,
  region: RecipientOcrRegion | undefined,
  primary: BankToGcashReceiptParse,
  visionKey: string,
  options: { ocr?: typeof googleVisionOcr } = {},
) {
  const unchanged = (reason: string) => ({
    attempted: false,
    accepted: false,
    changed: false,
    reason,
    recipient: primary.recipient,
    primaryRecipient: primary.recipient,
    observations: [],
    region: region || null,
    nativeRead: undefined as GoogleVisionOcrResult | undefined,
    enlargedRead: undefined as GoogleVisionOcrResult | undefined,
  });
  if (primary.provider !== "gotyme" || !visionKey) {
    return unchanged("refinement_unavailable");
  }
  if (
    !receiptImageSafeToDecode(bytes, undefined, 8 * 1024 * 1024) ||
    !validRecipientCrop(region, receiptImageDimensions(bytes))
  ) return unchanged("recipient_region_unavailable");

  try {
    // ImageScript crop/resize mutate their receiver. Keep the uploaded image
    // bytes untouched and clone the crop before changing its dimensions.
    const image = await Image.decode(bytes);
    const crop = image.crop(region.x, region.y, region.width, region.height);
    const nativePng = await crop.encode(1);
    const enlargedPng = await crop.clone().resize(
      region.width * 2,
      region.height * 2,
    ).encode(1);
    if (
      nativePng.length > 2 * 1024 * 1024 || enlargedPng.length > 2 * 1024 * 1024
    ) {
      return unchanged("recipient_crop_too_large");
    }
    const ocr = options.ocr || googleVisionOcr;
    const [native, enlarged] = await Promise.all(
      [nativePng, enlargedPng].map((png) =>
        ocr(visionKey, base64(png), {
          featureType: "DOCUMENT_TEXT_DETECTION",
          timeoutMs: 10_000,
        })
      ),
    );
    return {
      ...refineGotymeRecipient(primary, { native, enlarged }),
      attempted: true,
      primaryRecipient: primary.recipient,
      region,
      nativeRead: native,
      enlargedRead: enlarged,
    };
  } catch {
    // A failed optional reread must never erase the original receipt evidence.
    return { ...unchanged("recipient_reread_failed"), attempted: true };
  }
}
