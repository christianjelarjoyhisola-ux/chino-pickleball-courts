import type {
  GoogleVisionNativeWord,
  GoogleVisionOcrResult,
} from "./google-vision.ts";
import {
  parseProviderReceipt,
  type ProviderReceiptParse,
  type ReceiptVerificationContext,
  verifyProviderReceipt,
} from "./receipt-providers/index.ts";
import { readReceiptTransferStatus } from "./receipt-providers/transfer-status.ts";
import { refineGotymeRecipient } from "./gotyme-recipient-refinement.ts";

export type BankAdaptiveProvider =
  | "maya"
  | "bdopay"
  | "bpi"
  | "gotyme"
  | "maribank"
  | "securitybank";
export type BankProviderParse = Extract<
  ProviderReceiptParse,
  { provider: BankAdaptiveProvider }
>;
export const BANK_ADAPTIVE_PROVIDERS = [
  "maya",
  "bdopay",
  "bpi",
  "gotyme",
  "maribank",
  "securitybank",
] as const;
export function isBankAdaptiveProvider(
  value: string,
): value is BankAdaptiveProvider {
  return (BANK_ADAPTIVE_PROVIDERS as readonly string[]).includes(value);
}
export type BankPaymentFieldEvidence = {
  text: string;
  confidence?: number;
  occurrences: number;
  occurrenceConfidences?: Array<number | null>;
  source?: "native_recipient_crop_pair";
};
export type BankRecipientRefinement = {
  accepted: boolean;
  nativeRead?: GoogleVisionOcrResult;
  enlargedRead?: GoogleVisionOcrResult;
};
export type BankApprovalConfidence = {
  confidence: number;
  source: "bank_payment_fields" | "native" | "none";
  basis:
    | "native_payment_value_words"
    | "native_whole_image"
    | "missing_native_payment_evidence";
  fields: Record<string, BankPaymentFieldEvidence>;
  complete: boolean;
};

export function bankOcrText(read: GoogleVisionOcrResult): string {
  return read.layoutText ||
    read.nativeLines?.map((line) => line.text).join("\n") || read.text;
}

/** This classifier contains only formats covered by dedicated parser fixtures. */
export function bankLayoutFamily(provider: string, text: string): string {
  const has = (pattern: RegExp) => pattern.test(text);
  switch (provider) {
    case "maya":
      return has(/^Sent money via\s*$/im) && has(/^Account type\b/im) &&
          has(/^Reference\s*ID\b/im) && has(/\bmaya\b/i)
        ? "maya_sent_money_v1"
        : "unknown";
    case "bdopay":
      return has(/^Sent!?\s*$/im) && has(/^Send Money via InstaPay\b/im) &&
          has(/^Invoice number\b/im) && has(/^Reference no\./im)
        ? "bdopay_sent_instapay_v1"
        : "unknown";
    case "bpi":
      return has(/^Transfer successful!?/im) && has(/^Sent via BPI\b/im) &&
          has(/^Confirmation No\./im) && has(/^Transaction Ref\./im)
        ? "bpi_transfer_success_v1"
        : "unknown";
    case "gotyme":
      if (!has(/\bGoTyme\b/i)) return "unknown";
      if (
        has(/^Transferred!?\s*$/im) && has(/^Trace ID\b/im) &&
        has(/^Reference No\./im)
      ) return "gotyme_transferred_v1";
      return has(/^Transfer successful\b/im) && has(/^Transaction ID\b/im)
        ? "gotyme_transfer_success_v1"
        : "unknown";
    case "maribank":
      return has(/\bMariBank\b/i) && has(/^Money sent\b/im) &&
          has(/^Recipient\b/im) && has(/^Reference No\b/im)
        ? "maribank_money_sent_v1"
        : "unknown";
    case "securitybank":
      return has(/^Bank Transfer Complete\s*$/im) &&
          has(/^Sent via GCash\s*$/im) && has(/^InstaPay Invoice No\./im) &&
          has(/Security\s+Bank/i)
        ? "securitybank_gcash_transfer_v1"
        : "unknown";
    default:
      return "unknown";
  }
}

export function bankReceiptHasIncompleteStatus(text: string): boolean {
  const status = readReceiptTransferStatus(text);
  return status.failureStatus || status.pendingStatus;
}

function compact(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/\s/g, "");
}
function score(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= 1;
}
function nativeWordConfidence(
  word: GoogleVisionNativeWord,
  ignoreMasks: boolean,
): number | undefined {
  if (ignoreMasks && /[•‣●◦∙·*#]|\.{2,}|X{2,}/.test(word.text)) {
    const maskPositions = new Set<number>();
    for (const match of word.text.matchAll(/[•‣●◦∙·*#]+|\.{2,}|X{2,}/g)) {
      for (
        let index = match.index!;
        index < match.index! + match[0].length;
        index++
      ) maskPositions.add(index);
    }
    let position = 0;
    const visible = word.symbols.filter((symbol) => {
      const visibleCharacter = /[\p{L}\d]/u.test(symbol.text) &&
        !maskPositions.has(position);
      position += symbol.text.length;
      return visibleCharacter;
    });
    if (visible.length && visible.every((symbol) => score(symbol.confidence))) {
      return Math.min(...visible.map((symbol) => symbol.confidence!));
    }
  }
  return score(word.confidence) ? word.confidence : undefined;
}

/** Match OCR-derived values to native observed words, never to typed/expected values. */
function fieldEvidence(
  read: GoogleVisionOcrResult,
  raw: string | null | undefined,
  masked = false,
): BankPaymentFieldEvidence {
  const text = String(raw || "").trim();
  const value = compact(text);
  if (!value || !read.nativeLines?.length) return { text, occurrences: 0 };
  const words = read.nativeLines.flatMap((line) => line.words);
  let offset = 0;
  const spans = words.map((word) => {
    const start = offset;
    offset += compact(word.text).length;
    return { word, start, end: offset };
  });
  const native = words.map((word) => compact(word.text)).join("");
  const occurrences: Array<number | undefined> = [];
  let start = native.indexOf(value);
  while (start >= 0) {
    const end = start + value.length;
    const matched = spans.filter((span) =>
      span.end > start && span.start < end
    );
    // Substrings may omit a field label in the same word, but must not select
    // a suffix of a different account/reference or monetary value.
    const first = matched[0], last = matched.at(-1);
    const left = first
      ? compact(first.word.text).slice(0, start - first.start)
      : "";
    const right = last ? compact(last.word.text).slice(end - last.start) : "";
    const previous = first
      ? spans[spans.indexOf(first) - 1]?.word.text || ""
      : "";
    const attachedLabel =
      /^(?:REFERENCE|CONFIRMATION|INVOICE|ACCOUNT|REF)(?:NO\.|NUMBER\.?|ID\.?|\.)$/
        .test(left) ||
      (left === "NO." &&
        /^(?:REFERENCE|CONFIRMATION|INVOICE|ACCOUNT|REF\.?)$/i.test(previous));
    const boundarySafe = (!/[A-Z0-9.,]$/.test(left) || attachedLabel) &&
      !/^[A-Z0-9.,]/.test(right);
    if (boundarySafe && matched.length) {
      const valueWords = masked
        ? matched.filter((span) =>
          !/^(?:[•‣●◦∙·*#]+|\.{2,}|X{2,})$/.test(span.word.text)
        )
        : matched;
      const scores = valueWords.map((span) =>
        nativeWordConfidence(span.word, masked)
      );
      occurrences.push(
        scores.length && scores.every(score)
          ? Math.min(...scores as number[])
          : undefined,
      );
    }
    start = native.indexOf(value, start + 1);
  }
  return {
    text,
    occurrences: occurrences.length,
    occurrenceConfidences: occurrences.map((value) => value ?? null),
    ...(occurrences.length && occurrences.every(score)
      ? { confidence: Math.min(...occurrences as number[]) }
      : {}),
  };
}

function positiveStatus(
  provider: BankAdaptiveProvider,
  text: string,
): string | undefined {
  const patterns: Record<BankAdaptiveProvider, RegExp> = {
    maya: /^Sent money via\s*$/im,
    bdopay: /^Sent!?\s*$/im,
    bpi: /^Transfer successful!?\s*$/im,
    gotyme:
      /^(?:Transferred|Transfer successful|Transfer completed|Money sent|Successfully transferred)!?\s*$/im,
    maribank:
      /^(?:Money sent|Transfer successful|Transfer completed|Successfully transferred)!?\s*$/im,
    securitybank: /^Bank Transfer Complete\s*$/im,
  };
  return text.match(patterns[provider])?.[0]?.trim();
}

/** Label/value money rows include fees and totals even when a provider keeps
 * those values only as audit candidates rather than top-level parsed fields. */
function labelledMoney(text: string, label: RegExp): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    const row = lines[i].replace(label, "").trim() || lines[i + 1] || "";
    const match = row.match(
      /^(?:PHP|₱|P)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/i,
    );
    result.push(match?.[0] || "");
  }
  return result;
}

export function bankApprovalConfidence(
  read: GoogleVisionOcrResult,
  parsed: BankProviderParse,
  context: ReceiptVerificationContext,
  recipientRefinement?: BankRecipientRefinement | null,
): BankApprovalConfidence {
  const receipt = parsed.receipt;
  const fields: Record<string, BankPaymentFieldEvidence> = {};
  const add = (key: string, value?: string | null, masked = false) =>
    fields[key] = fieldEvidence(read, value, masked);
  add("reference", receipt.reference.raw);
  add("dateTime", receipt.timestamp.raw);
  // The Security Bank parser adds a PHP marker to its bare transfer amount
  // internally. Native evidence must use the actual labelled receipt value.
  const principal = parsed.provider === "securitybank"
    ? labelledMoney(bankOcrText(read), /^transfer\s+amount\s*:?\s*/i)[0]
    : receipt.amount.selectedCandidate?.raw;
  add("amount", principal);
  const recipient = receipt.recipient;
  add(
    "recipientName",
    "nameRaw" in recipient ? recipient.nameRaw : recipient.labelRaw,
    true,
  );
  add("recipientAccount", recipient.accountRaw, true);
  const destination =
    parsed.provider === "securitybank" && "bankRaw" in recipient
      ? recipient.bankRaw
      : bankOcrText(read).split(/\r?\n/).find((line) =>
        /\bgcash\b/i.test(line) && !/^Sent via\b/i.test(line)
      );
  add("destination", destination);
  if (parsed.provider === "bpi") {
    add(
      "timeZone",
      bankOcrText(read).match(/\(?GMT\s*\+\s*0?8(?::?00)?\)?/i)?.[0],
    );
  }
  add("status", positiveStatus(parsed.provider, bankOcrText(read)));
  if ("invoice" in receipt) add("secondaryReference", receipt.invoice.raw);
  if ("transactionReference" in receipt) {
    add("secondaryReference", receipt.transactionReference.raw);
  }
  if ("railReference" in receipt && receipt.railReference.value) {
    add("secondaryReference", receipt.railReference.raw);
  }
  // Preserve confidence in every principal display; a weak second amount must
  // never be replaced by confidence from the first identical display.
  receipt.amount.candidates.filter((candidate) => !candidate.excluded).forEach((
    candidate,
    index,
  ) =>
    add(
      `amountDisplay${index}`,
      parsed.provider === "securitybank" ? principal : candidate.raw,
    )
  );
  labelledMoney(
    bankOcrText(read),
    /^(?:\+?\s*fee|(?:transfer|service|processing|convenience)\s+fee)\s*:?\s*/i,
  )
    .forEach((value, index) => add(`fee${index}`, value));
  labelledMoney(bankOcrText(read), /^total(?:\s+amount(?:\s+sent)?)?\s*:?\s*/i)
    .forEach((value, index) => add(`total${index}`, value));
  if (
    parsed.provider === "gotyme" && recipientRefinement?.accepted &&
    recipientRefinement.nativeRead && recipientRefinement.enlargedRead
  ) {
    const primary = parseProviderReceipt("gotyme", bankOcrText(read));
    if (primary.provider === "gotyme") {
      const native = recipientRefinement.nativeRead,
        enlarged = recipientRefinement.enlargedRead;
      // Revalidate optical compatibility without configured account/name values.
      const validated = refineGotymeRecipient(primary.receipt, {
        native,
        enlarged,
      });
      const originalAccount = fieldEvidence(
        read,
        primary.receipt.recipient.accountRaw,
        true,
      );
      const originalAccountStrong = (originalAccount.confidence != null &&
        originalAccount.confidence >= .9) ||
        originalAccount.occurrenceConfidences?.some((confidence) =>
          confidence != null && confidence >= .9
        );
      const changesStrongAccount = originalAccountStrong &&
        bankFieldIdentity(
            "recipientAccount",
            primary.receipt.recipient.accountRaw || "",
          ) !==
          bankFieldIdentity(
            "recipientAccount",
            parsed.receipt.recipient.accountRaw || "",
          );
      if (
        validated.accepted && !changesStrongAccount &&
        compact(validated.recipient.accountRaw || "") ===
          compact(parsed.receipt.recipient.accountRaw || "") &&
        compact(validated.recipient.nameRaw || "") ===
          compact(parsed.receipt.recipient.nameRaw || "")
      ) {
        for (
          const [key, value] of [
            ["recipientName", validated.recipient.nameRaw],
            ["recipientAccount", validated.recipient.accountRaw],
          ]
        ) {
          const observations = [
            fieldEvidence(native, value, true),
            fieldEvidence(enlarged, value, true),
          ];
          if (
            observations.every((item) =>
              score(item.confidence) && item.confidence >= .9
            )
          ) {
            fields[key!] = {
              text: value || "",
              confidence: Math.min(
                ...observations.map((item) => item.confidence!),
              ),
              occurrences: 2,
              source: "native_recipient_crop_pair",
            };
          }
        }
      }
    }
  }
  const values = Object.values(fields);
  const complete = values.length > 0 &&
    values.every((field) => score(field.confidence));
  if (complete) {
    return {
      confidence: Math.min(...values.map((field) => field.confidence!)),
      source: "bank_payment_fields",
      basis: "native_payment_value_words",
      fields,
      complete: true,
    };
  }
  // Existing complete native reads without word geometry retain the established
  // policy. Once word evidence exists, missing/low critical values cannot be
  // washed by the whole-page average. Recovery always requires field evidence.
  const noNativeFields = !read.nativeLines?.length;
  const clean = !verifyProviderReceipt(parsed, context).flags.length &&
    !bankReceiptHasIncompleteStatus(read.text);
  if (
    noNativeFields && clean && read.confidenceSource === "native" &&
    score(read.confidence)
  ) {
    return {
      confidence: read.confidence,
      source: "native",
      basis: "native_whole_image",
      fields,
      complete: false,
    };
  }
  return {
    confidence: 0,
    source: "none",
    basis: "missing_native_payment_evidence",
    fields,
    complete: false,
  };
}

function moneyIdentity(value: string): string {
  return compact(value).replace(/^(?:PHP|₱|P)/, "").replace(/,/g, "");
}
/** OCR evidence signature preserves visible masks instead of filling them. */
export function bankFieldIdentity(key: string, value: string): string {
  if (/^(?:amount|fee|total)/.test(key)) return moneyIdentity(value);
  let result = compact(value);
  if (key === "reference" || key === "secondaryReference") {
    return result.replace(/[^A-Z0-9]/g, "");
  }
  if (key === "recipientAccount") {
    result = result.replace(/[()+-]/g, "").replace(
      /[•‣●◦∙·*#]+|\.{2,}|X{2,}/g,
      "*",
    );
    if (/^63\d{10}$/.test(result)) result = "0" + result.slice(2);
  }
  if (key === "recipientName") {
    result = result.replace(/[•‣●◦∙·*#]+|\.{2,}|X{2,}/g, "*").replace(
      /[.'-]/g,
      "",
    );
  }
  return result;
}
