import { bankLayoutFamily } from "../bank-ocr-evidence.ts";
import { parseProviderReceipt } from "./index.ts";

/** Settlement route for a MariBank booking that was paid from the GCash app
 * to the court's own configured GCash account (owner policy 2026-11-16). */
export const MARIBANK_PAID_TO_GCASH_ROUTE = "maribank_paid_to_gcash";

/**
 * True only when a MariBank booking's receipt is a clear GCash app receipt
 * and a GCash merchant account is configured. The full GCash verifier then
 * checks it against the GCash merchant settings.
 *
 * Never true for:
 * - any layout the MariBank verifier reads (including GCash-to-MariBank);
 * - MariBank-app-to-GCash screens, which print no date and a recycled
 *   6-digit reference, so they cannot prove they are new;
 * - receipts the GCash classifier finds conflicting or insufficient.
 */
export function isMaribankBookingPaidToGcash(input: {
  provider: string;
  originalText: string;
  gcashLayoutText: string;
  gcashMerchantNumber: string;
  typedReference?: string;
}): boolean {
  if (input.provider !== "maribank" || !input.gcashMerchantNumber.trim()) {
    return false;
  }
  if (!input.originalText.trim() || !input.gcashLayoutText.trim()) return false;
  if (bankLayoutFamily("maribank_direct", input.originalText) !== "unknown") {
    return false;
  }
  // MariBank's own "Transfer Result" screen, whatever its destination.
  if (/^Transfer Result$/im.test(input.originalText)) return false;
  // A GCash receipt naming MariBank was sent to MariBank, not to GCash
  // (for example GCash's "Sent GCash to MariBank" email notice).
  if (/\bMari ?Bank\b/i.test(input.originalText)) return false;
  const parsed = parseProviderReceipt("gcash", input.gcashLayoutText, {
    typedReference: input.typedReference || "",
  });
  return parsed.provider === "gcash" &&
    parsed.receipt.indicators.classification === "gcash";
}
