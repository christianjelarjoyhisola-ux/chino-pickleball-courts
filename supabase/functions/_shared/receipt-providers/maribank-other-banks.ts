import { parseTimestamp } from "./securitybank.ts";
import type { BankReceiptTimestamp } from "./bank-to-gcash.ts";

/** Fields read from another bank's app receipt for a transfer into MariBank.
 * Every value is found by its own type and must be the only one of its type.
 * Configured merchant details never enter extraction. */
export type OtherBankMaribankFields = {
  name: string | null;
  account: string | null;
  bank: string | null;
  principal: string | null;
  fee: string | null;
  reference: string | null;
  secondary: string | null;
  statusRaw: string | null;
  timestamp: BankReceiptTimestamp;
  /** Extra visible payment fields that must also carry native confidence. */
  extraFields: Record<string, string | null>;
  issues: string[];
};

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const PESO = /^(?:PHP|₱|P)\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})$/i;
const UPPER_NAME = /^[A-Z][A-Z'-]*(?: [A-Z][A-Z.'-]*)+$/;
const pesos = (s: string) => Number(s.match(PESO)![1].replace(/,/g, ""));

/** Vision may read a label and its value as one line ("Amount PHP 530.00").
 * Split a known label off the front; the value stays exactly as read. */
function splitLabels(lines: string[], labels: string[]): string[] {
  return lines.flatMap((line) => {
    const label = labels.find((l) => line.startsWith(l + " "));
    return label ? [label, line.slice(label.length + 1).trim()] : [line];
  });
}

function onlyOne(lines: string[], test: (line: string) => boolean, issues: string[]) {
  const found = lines.filter(test);
  if (found.length > 1) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
  return found.length === 1 ? found[0] : null;
}

export function isUnionbankReceipt(text: string): boolean {
  return /\bThank you for using UnionBank Online\b/i.test(text) &&
    /^UB\d{6,12}$/m.test(text);
}

/** UnionBank Online "Transaction Details" screen paid to MariBank. */
export function parseUnionbankToMaribank(input: string[]): OtherBankMaribankFields {
  // Longest labels first so "Instapay Reference Number" is not split as "Reference Number".
  const lines = splitLabels(input, [
    "Instapay Reference Number",
    "Reference Number:",
    "Sent Via",
    "Status",
    "Amount",
    "From",
    "To",
  ]);
  const issues: string[] = [];
  const one = (test: (line: string) => boolean) => onlyOne(lines, test, issues);
  const reference = one((s) => /^UB\d{6,12}$/.test(s));
  const statusRaw = lines.find((s, i) => s === "Successful" && lines[i - 1] === "Status") || null;
  // The status date and the "Request Submitted" date are the same moment;
  // differing visible timestamps are ambiguous.
  const stamps = lines.flatMap((s) => {
    const m = s.match(new RegExp(`^(${MONTH} \\d{1,2}, \\d{4}) \\|? ?(\\d{1,2}:\\d{2} (?:AM|PM))$`, "i"));
    return m ? [{ date: m[1], time: m[2] }] : [];
  });
  const dates = [...new Set(stamps.map((s) => `${s.date} ${s.time}`))];
  if (dates.length > 1) issues.push("MARIBANK_TIMESTAMP_AMBIGUOUS");
  // Date and time are scored separately: the "|" between them is a separator
  // glyph that carries no value and often reads weakly.
  const stamp = dates.length === 1 ? stamps[0] : null;
  const timestamp = stamp
    ? { ...parseTimestamp([`${stamp.date} ${stamp.time}`]), raw: stamp.date }
    : parseTimestamp([]);
  const instapayLabel = lines.indexOf("Instapay Reference Number");
  const secondary = instapayLabel >= 0 && /^\d{4,20}$/.test(lines[instapayLabel + 1] || "")
    ? lines[instapayLabel + 1]
    : null;
  if (!secondary) issues.push("INSTAPAY_QRPH_UNREADABLE");
  const rail = lines.find((s, i) => lines[i - 1] === "Sent Via" && /^insta ?[pf]ay$/i.test(s)) || null;
  if (!rail) issues.push("INSTAPAY_QRPH_UNREADABLE");
  // Recipient block: To, name, bank, account, then Amount and From.
  const to = lines.indexOf("To"), from = lines.indexOf("From"), amountLabel = lines.indexOf("Amount");
  if (lines.filter((s) => s === "To").length !== 1 || from < 0 || amountLabel < 0 || !(to < amountLabel && amountLabel < from)) {
    issues.push("MARIBANK_RECIPIENT_SECTION_UNREADABLE");
  }
  const block = to >= 0 && amountLabel > to ? lines.slice(to + 1, amountLabel) : [];
  const name = block.length === 3 && UPPER_NAME.test(block[0]) ? block[0] : null;
  const bank = block.length === 3 && /^MariBank$/i.test(block[1]) ? block[1] : null;
  const account = block.length === 3 && /^\d{4} \d{4} \d{3}$|^\d{11}$/.test(block[2]) ? block[2] : null;
  const principal = amountLabel >= 0 && PESO.test(lines[amountLabel + 1] || "") ? lines[amountLabel + 1] : null;
  // Only one peso amount is shown; any other is unexplained.
  if (lines.filter((s) => PESO.test(s)).length !== 1) issues.push("MARIBANK_AMOUNT_CONFLICT");
  return {
    name,
    account,
    bank,
    principal,
    fee: null,
    reference,
    secondary,
    statusRaw,
    timestamp,
    extraFields: {
      time: stamp?.time || null,
      rail,
      source: "Thank you for using UnionBank Online",
    },
    issues,
  };
}

/** Bank app confirmation "Your transaction has been processed." with an
 * MB-prefixed transaction reference that embeds its own YYMMDDHHMMSS time. */
export function isMbFundTransferReceipt(text: string): boolean {
  return /\bYour transaction has been\s+processed\./i.test(text) &&
    /^MB[A-Z]{3}\d{20}$/m.test(text) && /Fund Transfer/i.test(text);
}

export function parseMbFundTransferToMaribank(input: string[]): OtherBankMaribankFields {
  const lines = splitLabels(input, [
    "Transaction Reference Number",
    "Destination Account",
    "Transaction Type",
    "Transaction Date",
    "Transfer Channel",
    "Service Charge",
    "Source Account",
    "Destination",
    "InstaPay",
    "Purpose",
    "Amount",
  ]);
  const issues: string[] = [];
  const one = (test: (line: string) => boolean) => onlyOne(lines, test, issues);
  const reference = one((s) => /^MB[A-Z]{3}\d{20}$/.test(s));
  const secondary = one((s) => /^\d{13}$/.test(s));
  if (!secondary) issues.push("INSTAPAY_QRPH_UNREADABLE");
  const dateLine = one((s) => new RegExp(`^${MONTH} \\d{1,2}, \\d{4}$`, "i").test(s));
  const timeLine = one((s) => /^\d{1,2}:\d{2}:\d{2} (?:AM|PM)$/i.test(s));
  const timestamp = dateLine && timeLine
    ? { ...parseTimestamp([`${dateLine} ${timeLine}`]), raw: dateLine }
    : parseTimestamp([]);
  // The reference embeds the transaction moment; it must agree with the
  // visible date and time to the minute (seconds may differ slightly).
  const embedded = reference?.match(/^MB[A-Z]{3}(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (embedded && timestamp.instant) {
    const [, yy, mo, dd, hh, mi, ss] = embedded;
    const at = Date.parse(`20${yy}-${mo}-${dd}T${hh}:${mi}:${ss}+08:00`);
    if (!Number.isFinite(at) || Math.abs(at - Date.parse(timestamp.instant)) > 120_000) {
      issues.push("MARIBANK_TIMESTAMP_AMBIGUOUS");
    }
  }
  const text = lines.join("\n");
  const statusRaw = /^Your transaction has been processed\.$/m.test(text)
    ? "Your transaction has been processed."
    : /^Your transaction has been\nprocessed\.$/m.test(text)
    ? "Your transaction has been processed."
    : null;
  const account = one((s) => /^\d{11}$/.test(s));
  const bankLines = lines.flatMap((s, i) =>
    /^MariBank Philippines Inc\.?$/i.test(s)
      ? [s]
      : /^MariBank$/i.test(s) && /^Philippines Inc\.?$/i.test(lines[i + 1] || "")
      ? [`${s} ${lines[i + 1]}`]
      : []
  );
  if (bankLines.length > 1) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
  const bank = bankLines.length === 1 ? bankLines[0] : null;
  const name = one((s) => UPPER_NAME.test(s) && !/^PHP\b/.test(s));
  // One positive amount is the transfer; a service charge, when readable, is
  // the only other amount and must be zero or a separate peso value.
  const amounts = lines.filter((s) => PESO.test(s));
  const positive = amounts.filter((s) => pesos(s) > 0);
  const principal = positive.length === 1 ? positive[0] : null;
  if (positive.length > 1) issues.push("MARIBANK_AMOUNT_CONFLICT");
  const fees = amounts.filter((s) => s !== principal);
  const fee = fees.length === 1 ? fees[0] : null;
  if (fees.length > 1 || (fee && pesos(fee) !== 0)) issues.push("MARIBANK_AMOUNT_CONFLICT");
  if (!/^(?:Fund Transfer via|via InstaPay)$/m.test(text)) issues.push("INSTAPAY_QRPH_UNREADABLE");
  return {
    name,
    account,
    bank,
    principal,
    fee,
    reference,
    secondary,
    statusRaw,
    timestamp,
    extraFields: { time: timeLine },
    issues,
  };
}
