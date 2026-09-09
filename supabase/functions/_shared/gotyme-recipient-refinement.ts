import type {
  BankReceiptRecipient,
  BankToGcashReceiptParse,
} from "./receipt-providers/bank-to-gcash.ts";
import { parseGotymeToGcashReceipt } from "./receipt-providers/gotyme.ts";

export type GotymeRecipientCropObservation = {
  text: string;
  confidence: number;
  confidenceSource: "native" | "heuristic" | "none";
};

export type GotymeRecipientRefinementReason =
  | "unsupported_primary"
  | "primary_recipient_incomplete"
  | "crop_confidence_insufficient"
  | "crop_destination_unreadable"
  | "crop_recipient_incomplete"
  | "crop_name_changed"
  | "crop_accounts_disagree"
  | "change_not_optically_confusable"
  | "unchanged"
  | "optical_agreement";

export type GotymeRecipientRefinementObservation = {
  view: "native" | "enlarged";
  text: string;
  confidence: number;
  confidenceSource: GotymeRecipientCropObservation["confidenceSource"];
  destinationGcash: boolean;
  recipient: BankReceiptRecipient;
};

export type GotymeRecipientRefinement = {
  accepted: boolean;
  changed: boolean;
  reason: GotymeRecipientRefinementReason;
  originalAccountSuffix: string | null;
  observedAccountSuffix: string | null;
  recipient: BankReceiptRecipient;
  observations: GotymeRecipientRefinementObservation[];
};

function normalizedName(value: string | null): string {
  // Preserve every visible letter and mask. Only spacing/case may differ.
  return String(value || "").normalize("NFKC").replace(/\s/g, "")
    .toUpperCase();
}

function maskedAccountSuffix(recipient: BankReceiptRecipient): string | null {
  if (
    recipient.accountVisibility !== "masked" ||
    recipient.accountNormalized != null ||
    recipient.lineIndex == null || recipient.lineIndex < 0
  ) return null;
  const suffix = String(recipient.accountSuffix || "").normalize("NFKC")
    .replace(/\s/g, "").toUpperCase();
  if (
    !/^[A-Z0-9]{4,8}$/.test(suffix) || !/[A-Z]/.test(suffix) ||
    !/\d/.test(suffix)
  ) {
    return null;
  }
  const account = String(recipient.accountRaw || "").normalize("NFKC")
    .replace(/\s/g, "").toUpperCase();
  if (!account.endsWith(suffix)) return null;
  return /^[*•X]{3,}$/.test(account.slice(0, -suffix.length)) ? suffix : null;
}

function auditObservation(
  view: GotymeRecipientRefinementObservation["view"],
  observation: GotymeRecipientCropObservation,
): GotymeRecipientRefinementObservation {
  const text = typeof observation?.text === "string" ? observation.text : "";
  const parsed = parseGotymeToGcashReceipt(text);
  return {
    view,
    text,
    confidence: observation?.confidence,
    confidenceSource: observation?.confidenceSource,
    destinationGcash: parsed.indicators.destinationGcash,
    recipient: { ...parsed.recipient },
  };
}

function onlyOpticallyConfusableChange(
  original: string,
  observed: string,
): boolean {
  if (original.length !== observed.length) return false;
  let changedCharacters = 0;
  return [...original].every((character, index) => {
    if (character === observed[index]) return true;
    changedCharacters++;
    return changedCharacters <= 1 &&
      ((character === "O" && observed[index] === "0") ||
        (character === "0" && observed[index] === "O"));
  });
}

/**
 * Corroborate the same destination crop at native and enlarged resolutions.
 * Neither the saved merchant account nor any expected payment data is accepted
 * as input. Callers must still run normal recipient verification afterwards.
 * This returns recipient evidence only; it never rewrites raw OCR or payment
 * references, amount, dates, times, or the remaining primary receipt evidence.
 */
export function refineGotymeRecipient(
  primary: BankToGcashReceiptParse,
  crops: {
    native: GotymeRecipientCropObservation;
    enlarged: GotymeRecipientCropObservation;
  },
): GotymeRecipientRefinement {
  const observations = [
    auditObservation("native", crops?.native),
    auditObservation("enlarged", crops?.enlarged),
  ];
  const originalSuffix = maskedAccountSuffix(primary.recipient);
  const base: GotymeRecipientRefinement = {
    accepted: false,
    changed: false,
    reason: "primary_recipient_incomplete",
    originalAccountSuffix: originalSuffix,
    observedAccountSuffix: null,
    recipient: { ...primary.recipient },
    observations,
  };
  const reject = (reason: GotymeRecipientRefinementReason) => ({
    ...base,
    reason,
  });
  if (
    primary.provider !== "gotyme" ||
    primary.parserVersion !== "gotyme_to_gcash_v1"
  ) {
    return reject("unsupported_primary");
  }
  const originalName = normalizedName(primary.recipient.nameRaw);
  if (
    !originalSuffix || !primary.indicators.destinationGcash ||
    !/[*•]/.test(originalName) ||
    (originalName.match(/[A-Z]/g) || []).length < 3
  ) return reject("primary_recipient_incomplete");
  if (
    observations.some((observation) =>
      observation.confidenceSource !== "native" ||
      !Number.isFinite(observation.confidence) ||
      observation.confidence < 0.90 || observation.confidence > 1
    )
  ) return reject("crop_confidence_insufficient");
  if (observations.some((observation) => !observation.destinationGcash)) {
    return reject("crop_destination_unreadable");
  }
  const observedSuffixes = observations.map((observation) =>
    maskedAccountSuffix(observation.recipient)
  );
  if (observedSuffixes.some((suffix) => suffix == null)) {
    return reject("crop_recipient_incomplete");
  }
  if (
    observations.some((observation) =>
      normalizedName(observation.recipient.nameRaw) !== originalName
    )
  ) {
    return reject("crop_name_changed");
  }
  if (observedSuffixes[0] !== observedSuffixes[1]) {
    return reject("crop_accounts_disagree");
  }
  const observedSuffix = observedSuffixes[0]!;
  if (!onlyOpticallyConfusableChange(originalSuffix, observedSuffix)) {
    return reject("change_not_optically_confusable");
  }
  const changed = observedSuffix !== originalSuffix;
  return {
    ...base,
    accepted: true,
    changed,
    reason: changed ? "optical_agreement" : "unchanged",
    observedAccountSuffix: observedSuffix,
    // Keep original name, phone evidence, and source line. The two crop reads
    // support only the account characters, including their observed mask.
    recipient: changed
      ? {
        ...primary.recipient,
        accountRaw: observations[0].recipient.accountRaw,
        accountSuffix: observedSuffix,
      }
      : { ...primary.recipient },
  };
}
