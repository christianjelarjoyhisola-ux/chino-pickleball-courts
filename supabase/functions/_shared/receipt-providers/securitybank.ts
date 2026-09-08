import { extractReceiptAmount } from "../receipt-amount.ts";
import type {
  BankReceiptTimestamp,
  ReceiptDedupeKey,
  ReceiptVerificationContext,
} from "./bank-to-gcash.ts";

type Field = { value: string | null; ambiguous: boolean };
// Vision sometimes reads this receipt's label column before its value column.
// Reorder only complete, structurally validated blocks; leave uncertain blocks
// untouched so the ordinary parser sends them for review. Keep raw OCR in audit.
function normalizeColumns(input: string[]): string[] {
  const lines = [...input];
  for (let i = 0; i < lines.length; i++) {
    if (/^Bank:?$/i.test(lines[i]) &&
      /^Account\s*(?:No\.?|Number):?$/i.test(lines[i + 1] || "") &&
      /^Account Name:?$/i.test(lines[i + 2] || "") &&
      /^Transfer Method:?$/i.test(lines[i + 3] || "")) {
      const end = lines.findIndex((s, j) => j > i + 3 && /^Receipt sent to:?$/i.test(s));
      const values = end < 0 ? [] : lines.slice(i + 4, end);
      const accountIndex = values.findIndex((s) => /^(?:[*•●·.xX]{2,}\d{4}|\d{8,30})$/.test(s.replace(/[\s-]/g, "")));
      if ((accountIndex === 1 || accountIndex === 2) && values.length === accountIndex + 3 &&
        values.slice(0, accountIndex).every((s) => /^[A-Za-z][A-Za-z .&-]*$/.test(s)) &&
        /^[\p{L}][\p{L} .'-]+$/u.test(values[accountIndex + 1]) &&
        /^Insta\s*Pay$/i.test(values[accountIndex + 2])) {
        lines.splice(i, end - i,
          `Bank: ${values.slice(0, accountIndex).join(" ")}`,
          `Account No.: ${values[accountIndex]}`,
          `Account Name: ${values[accountIndex + 1]}`,
          `Transfer Method: ${values[accountIndex + 2]}`);
      }
    }
    if (/^\+?Fee:?$/i.test(lines[i]) && /^Total:?$/i.test(lines[i + 1] || "") &&
      money(lines[i + 2]) !== null && money(lines[i + 3]) !== null &&
      /^Date:?$/i.test(lines[i + 4] || "")) {
      lines.splice(i, 4, `+Fee: ${lines[i + 2]}`, `Total: ${lines[i + 3]}`);
    }
  }
  return lines;
}
const LABEL =
  /^(?:bank\b|account\s*(?:no\.?|number|name)\b|transfer\s*(?:method|amount)\b|receipt\s+sent\s+to\b|\+?\s*fee\b|total\b|date\b|insta\s*pay\s+invoice\b|ref(?:erence)?\.?\s*(?:no\.?|number|#))/i;
function field(lines: string[], pattern: RegExp): Field {
  const values: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (!match) continue;
    const parts = [match[1]?.trim() || ""];
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      if (
        LABEL.test(lines[j]) || /^(?:By going|Powered by|\d+g)/i.test(lines[j])
      ) break;
      parts.push(lines[j]);
    }
    values.push(parts.join(" ").trim());
  }
  return {
    value: values.length === 1 && values[0] ? values[0] : null,
    ambiguous: values.length > 1,
  };
}
function money(value: string | null): number | null {
  const match = (value || "").match(
    /^(?:PHP|₱|P)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/i,
  );
  const n = match ? Number(match[1].replace(/,/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function nameTokens(value: string): string[] {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(
    /[^A-Z ]/g,
    " ",
  ).trim().split(/\s+/).filter(Boolean);
}
function compareName(
  observed: string | null,
  expected: string,
): "exact" | "initial_compatible" | "missing" | "not_configured" | "mismatch" {
  if (!expected.trim()) return "not_configured";
  if (!observed) return "missing";
  const a = nameTokens(observed), b = nameTokens(expected);
  if (a.length < 2 || b.length < 2) return "mismatch";
  if (a.join(" ") === b.join(" ")) return "exact";
  if (
    a.length === b.length && a.at(-1)?.length === 1 &&
    b.at(-1)?.startsWith(a.at(-1)!) &&
    a.slice(0, -1).every((x, i) => x === b[i])
  ) return "initial_compatible";
  return "mismatch";
}
function compareAccount(
  raw: string | null,
  expected: string,
): "exact" | "suffix_match" | "missing" | "not_configured" | "mismatch" {
  const full = expected.replace(/[\s-]/g, "");
  if (!/^\d{8,30}$/.test(full)) return "not_configured";
  if (!raw) return "missing";
  const value = raw.replace(/[\s-]/g, "");
  if (/^\d{8,30}$/.test(value)) return value === full ? "exact" : "mismatch";
  const mask = value.match(/^[*•●·.xX]{2,}(\d{4})$/);
  return mask && full.endsWith(mask[1]) ? "suffix_match" : "mismatch";
}

export function parseSecurityBankReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
) {
  const lines = normalizeColumns(String(rawText || "").normalize("NFKC").split(/\r?\n/).map(
    (x) => x.replace(/\s+/g, " ").trim(),
  ).filter(Boolean));
  const text = lines.join("\n");
  const bank = field(lines, /^bank(?!\s+transfer\b)\s*:?\s*(.*)$/i);
  const account = field(lines, /^account\s*(?:no\.?|number)\s*:?\s*(.*)$/i);
  const name = field(lines, /^account\s*name\s*:?\s*(.*)$/i);
  const method = field(lines, /^transfer\s*method\s*:?\s*(.*)$/i);
  const amountField = field(lines, /^transfer\s*amount\s*:?\s*(.*)$/i);
  const feeField = field(lines, /^\+?\s*fee\s*:?\s*(.*)$/i);
  const totalField = field(lines, /^total\s*:?\s*(.*)$/i);
  const dateField = field(lines, /^date\s*:?\s*(.*)$/i);
  const refField = field(
    lines,
    /^ref(?:erence)?\.?\s*(?:no\.?|number|#)\s*:?\s*(.*)$/i,
  );
  const invoiceField = field(
    lines,
    /^insta\s*pay\s*invoice\s*(?:no\.?|number|#)?\s*:?\s*(.*)$/i,
  );
  const ref = refField.value?.replace(/\s/g, "") || "";
  const reference = /^\d{13}$/.test(ref) ? ref : null;
  const invoice = /^\d{4,20}$/.test(invoiceField.value || "")
    ? invoiceField.value
    : null;
  const transferAmount = money(amountField.value),
    transferFee = money(feeField.value),
    total = money(totalField.value);
  // Only the explicitly labelled transfer amount is payment. Fee/total never fill in missing amount evidence.
  const amount = extractReceiptAmount(
    transferAmount === null ? "" : `Amount PHP ${transferAmount.toFixed(2)}`,
    { provider: "securitybank" },
  );
  const issues: string[] = [];
  if (
    [
      bank,
      account,
      name,
      method,
      amountField,
      feeField,
      totalField,
      dateField,
      refField,
      invoiceField,
    ].some((x) => x.ambiguous)
  ) issues.push("SECURITYBANK_AMBIGUOUS_FIELDS");
  if (transferAmount === null || transferFee === null || total === null) {
    issues.push("SECURITYBANK_AMOUNT_BREAKDOWN_UNREADABLE");
  } else if (
    Math.round(transferAmount * 100) + Math.round(transferFee * 100) !==
      Math.round(total * 100)
  ) issues.push("SECURITYBANK_TOTAL_MISMATCH");
  if (
    dateField.value &&
    !/^[A-Za-z]+\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)$/i
      .test(dateField.value)
  ) issues.push("SECURITYBANK_TIMESTAMP_AMBIGUOUS");
  const typed = (options.typedReference || "").replace(/\s/g, "");
  return {
    provider: "securitybank" as const,
    destinationProvider: "securitybank" as const,
    parserVersion: "gcash_to_securitybank_v1" as const,
    reference: {
      value: reference,
      raw: refField.value,
      confidence: reference ? "high" as const : "low" as const,
      typedMatch: !typed
        ? "not_provided" as const
        : !/^\d{13}$/.test(typed)
        ? "typed_invalid" as const
        : !reference
        ? "ocr_missing" as const
        : typed === reference
        ? "match" as const
        : "mismatch" as const,
    },
    invoice: { value: invoice, raw: invoiceField.value },
    amount,
    transferFee,
    total,
    timestamp: parseTimestamp(dateField.value ? [dateField.value] : []),
    recipient: {
      nameRaw: name.value,
      accountRaw: account.value,
      bankRaw: bank.value,
    },
    indicators: {
      providerBrand: /^Sent via GCash$/im.test(text),
      competingProviderBrand: /^Sent via (?!GCash$).+/im.test(text),
      transferSuccess: /^Bank Transfer Complete$/im.test(text),
      destinationSecurityBank: /^Security\s+Bank(?:\s+Corporation)?$/i.test(
        bank.value || "",
      ),
      instaPay: /^Insta\s*Pay$/i.test(method.value || ""),
      failureStatus:
        /\b(?:failed|pending|unsuccessful|reversed|cancelled|canceled|scheduled)\b/i
          .test(text),
    },
    issues,
  };
}
export type SecurityBankReceiptParse = ReturnType<
  typeof parseSecurityBankReceipt
>;
export function verifySecurityBankReceipt(
  parsed: SecurityBankReceiptParse,
  context: ReceiptVerificationContext & { now?: string },
) {
  const flags = [...parsed.issues];
  const add = (flag: string) => {
    if (!flags.includes(flag)) flags.push(flag);
  };
  if (
    !parsed.indicators.providerBrand || parsed.indicators.competingProviderBrand
  ) add("SECURITYBANK_SOURCE_UNREADABLE");
  if (!parsed.indicators.transferSuccess || parsed.indicators.failureStatus) {
    add("TRANSFER_STATUS_UNREADABLE");
  }
  if (!parsed.indicators.destinationSecurityBank) {
    add("SECURITYBANK_DESTINATION_MISMATCH");
  }
  if (!parsed.indicators.instaPay) add("INSTAPAY_QRPH_UNREADABLE");
  if (!parsed.reference.value) add("REF_UNREADABLE");
  if (!["match", "not_provided"].includes(parsed.reference.typedMatch)) {
    add(
      parsed.reference.typedMatch === "typed_invalid"
        ? "REF_FORMAT_INVALID"
        : "REF_MISMATCH",
    );
  }
  if (!parsed.invoice.value) add("SECURITYBANK_INVOICE_UNREADABLE");
  if (
    !context.pricingAvailable || context.expectedAmount == null ||
    context.expectedAmount <= 0
  ) add("PRICING_UNAVAILABLE");
  else if (
    !parsed.amount.reliable || parsed.amount.amount == null ||
    parsed.amount.ambiguous
  ) add("AMOUNT_UNREADABLE");
  else if (
    Math.round(parsed.amount.amount * 100) !==
      Math.round(context.expectedAmount * 100)
  ) add("AMOUNT_MISMATCH");
  const recipientComparison = compareName(
    parsed.recipient.nameRaw,
    context.expectedRecipientName || "",
  );
  const recipientAccountComparison = compareAccount(
    parsed.recipient.accountRaw,
    context.expectedRecipientNumber || "",
  );
  if (!["exact", "initial_compatible"].includes(recipientComparison)) {
    add(
      recipientComparison === "not_configured"
        ? "MERCHANT_CONFIG_MISSING"
        : recipientComparison === "missing"
        ? "RECEIVER_NAME_UNREADABLE"
        : "RECEIVER_NAME_MISMATCH",
    );
  }
  if (!["exact", "suffix_match"].includes(recipientAccountComparison)) {
    add(
      recipientAccountComparison === "not_configured"
        ? "MERCHANT_CONFIG_MISSING"
        : recipientAccountComparison === "missing"
        ? "RECEIVER_ACCOUNT_UNREADABLE"
        : "RECEIVER_ACCOUNT_MISMATCH",
    );
  }
  const at = Date.parse(parsed.timestamp.instant || ""),
    start = Date.parse(context.bookingStartedAt || "");
  if (
    !Number.isFinite(at) || !Number.isFinite(start) ||
    !context.bookingStartedDate
  ) add("TIME_UNREADABLE");
  else {
    if (parsed.timestamp.date !== context.bookingStartedDate) {
      add("DATE_NOT_TODAY");
    }
    const age = (at - start) / 60000;
    if (age < -context.earlyToleranceMinutes) add("TIME_FUTURE");
    if (age > context.paymentWindowMinutes) add("TIME_EXPIRED");
    const now = context.now ? Date.parse(context.now) : Date.now();
    if (
      !Number.isFinite(now) || at > now + context.earlyToleranceMinutes * 60000
    ) add("TIME_FUTURE");
  }
  const dedupeKeys: ReceiptDedupeKey[] = [];
  if (parsed.reference.value) {
    dedupeKeys.push({
      key: `securitybank:${parsed.reference.value}`,
      providerKey: "securitybank",
      duplicateFlag: "DUPLICATE_REF",
    });
    // Shared GCash reference namespace prevents reuse through a different payment option.
    dedupeKeys.push({
      key: parsed.reference.value,
      providerKey: "gcash",
      duplicateFlag: "DUPLICATE_REF",
    });
  }
  if (parsed.invoice.value) {
    dedupeKeys.push({
      key: `gcash_instapay_invoice:${parsed.invoice.value}`,
      providerKey: "gcash_instapay_invoice",
      duplicateFlag: "DUPLICATE_INSTAPAY_REF",
    });
  }
  return {
    provider: "securitybank" as const,
    destinationProvider: "securitybank" as const,
    parserVersion: parsed.parserVersion,
    flags,
    recipientComparison,
    recipientAccountComparison,
    dedupeKeys,
  };
}
export type SecurityBankReceiptVerificationEvidence = ReturnType<
  typeof verifySecurityBankReceipt
>;

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function validDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseTimestamp(lines: string[]): BankReceiptTimestamp {
  const pattern =
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\s*,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\b/i;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = lines[lineIndex].match(pattern);
    if (!match) continue;
    const month = MONTHS[match[1].toLowerCase()] || 0;
    const day = Number(match[2]);
    const year = Number(match[3]);
    let hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const meridiem = match[7].toUpperCase();
    if (
      !validDateParts(year, month, day) || hour < 1 || hour > 12 ||
      minute > 59 || second > 59
    ) {
      return {
        raw: match[0],
        date: null,
        time24: null,
        zone: "Asia/Manila",
        instant: null,
        completeness: "invalid",
        lineIndex,
      };
    }
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;
    const date = `${year.toString().padStart(4, "0")}-${
      month.toString().padStart(2, "0")
    }-${day.toString().padStart(2, "0")}`;
    const time24 = `${hour.toString().padStart(2, "0")}:${
      minute.toString().padStart(2, "0")
    }`;
    const instant = new Date(
      `${date}T${time24}:${second.toString().padStart(2, "0")}+08:00`,
    );
    return {
      raw: match[0],
      date,
      time24,
      zone: "Asia/Manila",
      instant: Number.isNaN(instant.getTime()) ? null : instant.toISOString(),
      completeness: Number.isNaN(instant.getTime()) ? "invalid" : "date_time",
      lineIndex,
    };
  }
  return {
    raw: null,
    date: null,
    time24: null,
    zone: "Asia/Manila",
    instant: null,
    completeness: "missing",
    lineIndex: null,
  };
}
