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

/** Join only observed mask fragments inside the destination block. Vision can
 * split the same masked account into `**` and `*9W07` on adjacent native rows.
 * This preserves every character; O/0 correction still requires optical proof. */
export function normalizeGotymeMaskFragments(rawText: string): string {
  const lines = String(rawText || "").split(/\r?\n/);
  let inRecipient = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (/^(?:to|recipient)\b/i.test(line)) inRecipient = true;
    if (
      /^(?:from|sender|source|amount|fee|total|reference|trace|date)\b/i.test(
        line,
      )
    ) inRecipient = false;
    if (!inRecipient || !/^[*•xX]{1,}$/.test(line)) continue;
    const next = (lines[index + 1] || "").replace(/\s/g, "");
    if (!/^[*•xX]{1,}[A-Z0-9]{4,8}$/i.test(next)) continue;
    const joined = line + next;
    if (!/^[*•xX]{3,}[A-Z0-9]{4,8}$/i.test(joined)) continue;
    lines.splice(index, 2, joined);
  }
  return lines.join("\n");
}

export function parseGotymeToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BankToGcashReceiptParse & { provider: "gotyme" } {
  rawText = normalizeGotymeMaskFragments(rawText);
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
  const evidence = verifyBankToGcashReceipt(
    parsed,
    context,
    GOTYME_CONFIG.unreadableFlag,
  ) as BankReceiptVerificationEvidence & { provider: "gotyme" };
  evidence.recipientPolicy =
    context.gotymeRecipientPolicy === "masked_name_only"
      ? "masked_name_only"
      : "name_and_account";
  if (evidence.recipientPolicy === "masked_name_only") {
    // The owner-selected policy checks the actually observed recipient name.
    // Keep account observations in the audit, but they do not decide receipt
    // eligibility. All transfer, destination, amount, time and replay gates stay.
    const accountOnlyFlags = new Set([
      "MERCHANT_CONFIG_MISSING",
      "RECEIVER_ACCOUNT_MISMATCH",
      "RECEIVER_ACCOUNT_UNREADABLE",
      "WRONG_GCASH_NUMBER",
      "NUMBER_UNREADABLE",
    ]);
    evidence.flags = evidence.flags.filter((flag) =>
      !accountOnlyFlags.has(flag)
    );
    if (!String(context.expectedRecipientName || "").trim()) {
      evidence.flags.push("MERCHANT_CONFIG_MISSING");
    }
    if (
      !["exact", "masked_compatible"].includes(
        evidence.recipientComparison.name,
      )
    ) {
      const flag = evidence.recipientComparison.name === "mismatch"
        ? "RECEIVER_NAME_MISMATCH"
        : "RECEIVER_NAME_UNREADABLE";
      if (!evidence.flags.includes(flag)) evidence.flags.push(flag);
    }
  }
  return evidence;
}
