import { extractReceiptAmount } from "../receipt-amount.ts";
import { readReceiptTransferStatus } from "./transfer-status.ts";
import { compareAccount, compareName, parseTimestamp } from "./securitybank.ts";
import type {
  BankReceiptTimestamp,
  ReceiptDedupeKey,
  ReceiptVerificationContext,
} from "./bank-to-gcash.ts";

const MONEY = /^(?:PHP|₱|P)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/i;
function money(raw: string | null): number | null {
  if (raw === "FREE") return 0;
  const m = raw?.match(MONEY);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
function nativeTimestamp(raw: string | null): BankReceiptTimestamp {
  const m = raw?.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4}), (\d{2}):(\d{2})$/);
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59) return parseTimestamp([]);
  const h = Number(m[4]);
  const parsed = parseTimestamp([
    `${m[2]} ${m[1]}, ${m[3]} ${h % 12 || 12}:${m[5]} ${h < 12 ? "AM" : "PM"}`,
  ]);
  return { ...parsed, raw };
}
/** Destination-specific verifier. OCR column repair is limited to typed,
 * contiguous blocks; expected account/name values never enter extraction. */
export function parseMaribankDirectReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
) {
  const lines = String(rawText || "").normalize("NFKC").split(/\r?\n/).map(
    (x) => x.replace(/\s+/g, " ").trim(),
  ).filter(Boolean);
  const text = lines.join("\n");
  const source = /^Sent via GCash$/im.test(text)
    ? "gcash" as const
    : "maribank" as const;
  const status = readReceiptTransferStatus(text);
  const issues: string[] = [];
  const unique = (values: string[]): string | null => {
    if (values.length > 1) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
    return values.length === 1 ? values[0] : null;
  };
  let account: string | null = null,
    name: string | null = null,
    bank: string | null = null;
  let principal: string | null = null,
    fee: string | null = null,
    totalRaw: string | null = null;
  let referenceRaw: string | null = null,
    invoiceRaw: string | null = null,
    dateRaw: string | null = null;
  let method: string | null = null;
  if (source === "maribank") {
    let breakdownReference: string | null = null;
    if (
      lines.filter((s) => s === "To").length !== 1 ||
      lines.filter((s) => s === "From").length !== 1
    ) issues.push("MARIBANK_RECIPIENT_SECTION_UNREADABLE");
    const accounts = lines.map((s, i) => ({
      m: s.match(/^Acct\. No\.: (\d{11})$/),
      i,
    })).filter((x) => x.m);
    if (accounts.length === 1) {
      const { m, i } = accounts[0];
      account = m![1];
      if (
        /^(?:M )?MariBank$/.test(lines[i - 1] || "") &&
        /^[A-Za-z][A-Za-z .'-]+$/.test(lines[i - 2] || "")
      ) {
        bank = lines[i - 1];
        name = lines[i - 2];
      }
      const values = lines.slice(i + 1).filter((s) =>
        !/^(?:Transfer Amount|Transfer Fee|Total Amount|Reference Number)$/
          .test(s)
      );
      const labels = [
        "Transfer Amount",
        "Transfer Fee",
        "Total Amount",
        "Reference Number",
      ];
      const positions = labels.map((label) => lines.indexOf(label));
      const columnLayout = positions.every((position, n) =>
        position >= 0 && position < i &&
        (!n || position === positions[n - 1] + 1)
      );
      const rowLayout = labels.every((label, n) =>
        lines[i + 1 + n * 2] === label
      );
      if (!columnLayout && !rowLayout) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
      if (
        money(values[0]) !== null &&
        /^(?:FREE|(?:PHP|₱|P)?\s*\d+\.\d{2})$/.test(values[1] || "") &&
        money(values[2]) !== null
      ) {
        [principal, fee, totalRaw] = values;
        breakdownReference = values[3] || null;
      }
    } else if (accounts.length > 1) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
    referenceRaw = unique(lines.filter((s) => /^BC\d{18}$/.test(s)));
    if (referenceRaw !== breakdownReference) referenceRaw = null;
    if (lines.filter((s) => s === "Reference Number").length !== 1) {
      referenceRaw = null;
    }
    const di = lines.indexOf("Transaction Date & Time");
    dateRaw = di >= 0 && lines.filter((s) =>
          s === "Transaction Date & Time"
        ).length === 1
      ? lines[di + 1] || null
      : null;
    for (const label of ["Transfer Amount", "Transfer Fee", "Total Amount"]) {
      if (lines.filter((s) => s === label).length !== 1) {
        issues.push("MARIBANK_AMOUNT_BREAKDOWN_UNREADABLE");
      }
    }
    // Every visible native amount must agree with its role; the headline
    // amount is an independent check, never a replacement for the breakdown.
    const headline = lines.findIndex((s) => /^Transfer Successful!$/i.test(s));
    if (
      headline >= 0 && money(lines[headline + 1] || null) !== money(principal)
    ) issues.push("MARIBANK_AMOUNT_CONFLICT");
    const expectedMoney = [money(principal), money(totalRaw), 0];
    if (
      lines.filter((s) => MONEY.test(s)).some((s) =>
        !expectedMoney.includes(money(s))
      )
    ) issues.push("MARIBANK_AMOUNT_CONFLICT");
  } else {
    // GCash may emit labels as rows, columns, or mixed. Only reorder an
    // exact known label sequence followed by the correctly typed values.
    let canonical = text;
    canonical = canonical.replace(
      /Transfer Amount\n\+Fee\nTotal\nDate\nInstaPay Invoice No\.\nRef No\.\n([^\n]+)\n([^\n]+)\n([^\n]+)\n([^\n]+)\n(\d{4,20})\n(\d{13})\n/g,
      (m, a, f, t, d, i, r) =>
        [a, f, t].every((x) => money(x) !== null)
          ? `Transfer Amount: ${a}\n+Fee: ${f}\nTotal: ${t}\nDate: ${d}\nInstaPay Invoice No.: ${i}\nRef No.: ${r}\n`
          : m,
    );
    canonical = canonical.replace(
      /Bank\nAccount No\.\nAccount Name\nTransfer Method\n(?:Receipt sent to\n)?(MariBank)\n([\d*•●·.xX\s]+)\n([A-Za-z][A-Za-z .'-]+)\n(InstaPay)\n/g,
      (_m, b, a, n, t) =>
        `Bank: ${b}\nAccount No.: ${
          a.replace(/\s/g, "")
        }\nAccount Name: ${n}\nTransfer Method: ${t}\n`,
    );
    canonical = canonical.replace(
      /Account No\.\nAccount Name\nTransfer Method\n(?:Receipt sent to\n)?([\d*•●·.xX\s]+)\n([A-Za-z][A-Za-z .'-]+)\n(InstaPay)\n/g,
      (_m, a, n, t) =>
        `Account No.: ${
          a.replace(/\s/g, "")
        }\nAccount Name: ${n}\nTransfer Method: ${t}\n`,
    );
    canonical = canonical.replace(
      /Transfer Amount\n\+Fee\nTotal\n([^\n]+)\n([^\n]+)\n([^\n]+)\n/g,
      (m, a, f, t) =>
        [a, f, t].every((x) => money(x) !== null)
          ? `Transfer Amount: ${a}\n+Fee: ${f}\nTotal: ${t}\n`
          : m,
    );
    canonical = canonical.replace(
      /Date\nInstaPay Invoice No\.\nRef No\.\n([^\n]+)\n(\d{4,20})\n(\d{13})\n/g,
      (_m, d, i, r) =>
        `Date: ${d}\nInstaPay Invoice No.: ${i}\nRef No.: ${r}\n`,
    );
    const row = (label: string): string | null =>
      unique(
        [...canonical.matchAll(
          new RegExp(`^${label}(?:: ?|\\n)([^\\n]+)$`, "gm"),
        )].map((m) => m[1]),
      );
    bank = row("Bank");
    account = row("Account No\\.");
    name = row("Account Name");
    method = row("Transfer Method");
    principal = row("Transfer Amount");
    fee = row("\\+Fee");
    totalRaw = row("Total");
    referenceRaw = row("Ref No\\.");
    invoiceRaw = row("InstaPay Invoice No\\.");
    dateRaw = row("Date");
  }
  const transferAmount = money(principal),
    transferFee = money(fee),
    total = money(totalRaw);
  if (transferAmount === null || transferFee === null || total === null) {
    issues.push("MARIBANK_AMOUNT_BREAKDOWN_UNREADABLE");
  } else if (
    Math.round(transferAmount * 100) + Math.round(transferFee * 100) !==
      Math.round(total * 100)
  ) issues.push("MARIBANK_TOTAL_MISMATCH");
  const referencePattern = source === "gcash" ? /^\d{13}$/ : /^BC\d{18}$/;
  const reference = referencePattern.test(referenceRaw || "")
    ? referenceRaw
    : null;
  const typed = (options.typedReference || "").replace(/\s/g, "").toUpperCase();
  const timestamp = source === "gcash"
    ? parseTimestamp(dateRaw ? [dateRaw] : [])
    : nativeTimestamp(dateRaw);
  // Date parser must consume the complete field, not accept a timestamp within unrelated text.
  if (
    source === "gcash" && dateRaw && timestamp.raw?.trim() !== dateRaw.trim()
  ) issues.push("MARIBANK_TIMESTAMP_AMBIGUOUS");
  const statusRaw = source === "gcash"
    ? lines.find((s) => /^Bank Transfer Complete$/i.test(s))
    : lines.find((s) => /^Transfer Successful!$/i.test(s));
  return {
    provider: "maribank_direct" as const,
    destinationProvider: "maribank" as const,
    parserVersion: "maribank_direct_v1" as const,
    source,
    reference: {
      value: reference,
      raw: referenceRaw,
      confidence: reference ? "high" as const : "low" as const,
      typedMatch: !typed
        ? "not_provided" as const
        : !referencePattern.test(typed)
        ? "typed_invalid" as const
        : !reference
        ? "ocr_missing" as const
        : typed === reference
        ? "match" as const
        : "mismatch" as const,
    },
    invoice: {
      value: source === "gcash" && /^\d{4,20}$/.test(invoiceRaw || "")
        ? invoiceRaw
        : null,
      raw: invoiceRaw,
    },
    amount: extractReceiptAmount(
      transferAmount === null ? "" : `Amount PHP ${transferAmount.toFixed(2)}`,
      { provider: "maribank" },
    ),
    transferFee,
    total,
    timestamp,
    recipient: { nameRaw: name, accountRaw: account, bankRaw: bank },
    paymentFields: {
      reference: referenceRaw,
      dateTime: timestamp.raw,
      amount: principal,
      fee,
      total: totalRaw,
      recipientName: name,
      recipientAccount: account,
      destination: bank,
      status: statusRaw || null,
      ...(source === "gcash"
        ? {
          secondaryReference: invoiceRaw,
          source: "Sent via GCash",
          rail: method,
        }
        : {}),
    },
    indicators: {
      providerBrand: source === "gcash" ||
        (/\bMariBank\b/.test(text) && /^Transfer Result$/m.test(text)),
      competingProviderBrand: source === "maribank" &&
        /GoTyme|Sent via BPI|Security Bank/i.test(text),
      transferSuccess: !!statusRaw && !status.failureStatus &&
        !status.pendingStatus,
      destinationMaribank: /^(?:M )?MariBank$/.test(bank || ""),
      instaPay: method === "InstaPay",
      ...status,
    },
    issues: [...new Set(issues)],
  };
}
export type MaribankDirectReceiptParse = ReturnType<
  typeof parseMaribankDirectReceipt
>;
export function verifyMaribankDirectReceipt(
  parsed: MaribankDirectReceiptParse,
  context: ReceiptVerificationContext & { now?: string },
) {
  const flags = [...parsed.issues];
  const add = (flag: string) => {
    if (!flags.includes(flag)) flags.push(flag);
  };
  if (
    !parsed.indicators.providerBrand || parsed.indicators.competingProviderBrand
  ) add("MARIBANK_SOURCE_UNREADABLE");
  if (parsed.indicators.failureStatus) add("TRANSFER_STATUS_INVALID");
  if (parsed.indicators.pendingStatus) add("TRANSFER_PENDING");
  if (
    !parsed.indicators.transferSuccess && !parsed.indicators.failureStatus &&
    !parsed.indicators.pendingStatus
  ) {
    add("TRANSFER_STATUS_UNREADABLE");
  }
  if (!parsed.indicators.destinationMaribank) {
    add("MARIBANK_DESTINATION_MISMATCH");
  }
  if (parsed.source === "gcash" && !parsed.indicators.instaPay) {
    add("INSTAPAY_QRPH_UNREADABLE");
  }
  if (!parsed.reference.value) add("REF_UNREADABLE");
  if (!["match", "not_provided"].includes(parsed.reference.typedMatch)) {
    add(
      parsed.reference.typedMatch === "typed_invalid"
        ? "REF_FORMAT_INVALID"
        : "REF_MISMATCH",
    );
  }
  if (parsed.source === "gcash" && !parsed.invoice.value) {
    add("MARIBANK_INVOICE_UNREADABLE");
  }
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
      key: `maribank:${parsed.reference.value}`,
      providerKey: "maribank",
      duplicateFlag: "DUPLICATE_REF",
    });
    // Shared GCash reference namespace prevents reuse through a different payment option.
    if (parsed.source === "gcash") {
      dedupeKeys.push({
        key: parsed.reference.value,
        providerKey: "gcash",
        duplicateFlag: "DUPLICATE_REF",
      });
    }
  }
  if (parsed.invoice.value) {
    dedupeKeys.push({
      key: `gcash_instapay_invoice:${parsed.invoice.value}`,
      providerKey: "gcash_instapay_invoice",
      duplicateFlag: "DUPLICATE_INSTAPAY_REF",
    });
  }
  return {
    provider: "maribank_direct" as const,
    destinationProvider: "maribank" as const,
    parserVersion: parsed.parserVersion,
    flags,
    recipientComparison,
    recipientAccountComparison,
    dedupeKeys,
  };
}
export type MaribankDirectReceiptVerificationEvidence = ReturnType<
  typeof verifyMaribankDirectReceipt
>;
