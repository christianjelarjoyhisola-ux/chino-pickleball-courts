import {
  type BankReceiptVerificationEvidence,
  type BankToGcashReceiptParse,
  parseBankToGcashReceipt,
  type ReceiptVerificationContext,
  verifyBankToGcashReceipt,
} from "./bank-to-gcash.ts";
import { extractReceiptAmount } from "../receipt-amount.ts";

const GOTYME_CONFIG = {
  provider: "gotyme" as const,
  parserVersion: "gotyme_to_gcash_v1" as const,
  brandPattern: /\bgo\s*tyme\b|\bgotyme\b/i,
  competingBrandPattern: /\bmari\s*bank\b|\bmaribank\b/i,
  competingProvider: "maribank" as const,
  unreadableFlag: "GOTYME_RECEIPT_UNREADABLE",
};

export function parseGotymeToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BankToGcashReceiptParse & { provider: "gotyme" } {
  const parsed = parseBankToGcashReceipt(rawText, options, GOTYME_CONFIG) as
    & BankToGcashReceiptParse
    & { provider: "gotyme" };
  const lines = String(rawText || "").normalize("NFKC").split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean);
  const amountRows: string[] = [];
  lines.forEach((line, index) => {
    if (!/^(?:transfer\s+)?amount\b/i.test(line)) return;
    amountRows.push(line);
    if (/^(?:transfer\s+)?amount\s*[:\-]?$/i.test(line) && lines[index + 1]) {
      amountRows.push(lines[index + 1]);
    }
  });
  if (amountRows.length) {
    // GoTyme's Total includes the fee. The credited transfer is the Amount row.
    parsed.amount = extractReceiptAmount(amountRows.join("\n"), {
      provider: "gotyme",
    });
    const labelledValues = (label: RegExp): number[] => {
      const values: number[] = [];
      lines.forEach((line, index) => {
        const match = line.match(label);
        if (!match) return;
        const raw = (match[1] || lines[index + 1] || "").trim();
        const money = raw.match(
          /^(?:₱|PHP|P)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/i,
        );
        if (money) values.push(Number(money[1].replace(/,/g, "")));
      });
      return [...new Set(values)];
    };
    const fees = labelledValues(/^(?:transfer\s+)?fee\s*[:\-]?\s*(.*)$/i);
    const totals = labelledValues(/^total(?:\s+amount)?\s*[:\-]?\s*(.*)$/i);
    const headlineAmounts = labelledValues(/^transferred[!.]?\s*$/i);
    const amount = parsed.amount.amount;
    if (
      amount != null && (fees.length > 1 || totals.length > 1 ||
        headlineAmounts.some((headline) =>
          Math.abs(headline - amount) > 0.01
        ) ||
        (totals.length === 1 &&
          Math.abs(totals[0] - amount - (fees[0] || 0)) > 0.01))
    ) {
      parsed.amount = {
        ...parsed.amount,
        reliable: false,
        ambiguous: true,
        reason: "ambiguous",
      };
    }
    parsed.issues = parsed.issues.filter((issue) =>
      !["AMOUNT_MISSING", "AMBIGUOUS_AMOUNT"].includes(issue)
    );
    if (parsed.amount.amount == null) parsed.issues.push("AMOUNT_MISSING");
    if (parsed.amount.ambiguous) parsed.issues.push("AMBIGUOUS_AMOUNT");
  }
  return parsed;
}

export function verifyGotymeToGcashReceipt(
  parsed: BankToGcashReceiptParse & { provider: "gotyme" },
  context: ReceiptVerificationContext,
): BankReceiptVerificationEvidence & { provider: "gotyme" } {
  return verifyBankToGcashReceipt(
    parsed,
    context,
    GOTYME_CONFIG.unreadableFlag,
  ) as BankReceiptVerificationEvidence & { provider: "gotyme" };
}
