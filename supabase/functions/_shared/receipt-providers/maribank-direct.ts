import { parseAdditionalMaribankReceipt, maskedMaribankNameMatches } from "./maribank-incoming.ts";
import { extractReceiptAmount } from "../receipt-amount.ts";
import { readReceiptTransferStatus } from "./transfer-status.ts";
import { compareAccount, compareName, parseTimestamp } from "./securitybank.ts";
import type {
  BankReceiptTimestamp,
  ReceiptDedupeKey,
  ReceiptVerificationContext,
} from "./bank-to-gcash.ts";

/** A phone status-bar clock: hours and minutes with no digit, colon or
 * decimal attached (so "3:57.1" or "12:30:45" never qualify). */
const STATUS_BAR_CLOCK = /(?<![\d:.,])((?:[01]?\d|2[0-3]):[0-5]\d)(?![\d:.,])/g;
/** Any visible calendar date means the receipt is not a no-date screen. */
const ANY_DATE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b20\d{2}\b/i;
export type MaribankScreenClock = {
  raw: string;
  hour: number;
  minute: number;
  /** 1-12 is read as a 12-hour clock; 0 or 13-23 only as a 24-hour clock. */
  twelveHour: boolean;
};
const MONEY = /^(?:PHP|₱|P)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/i;
function money(raw: string | null): number | null {
  if (raw === "FREE") return 0;
  const m = raw?.match(MONEY);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
/** Match one complete bank-transfer table. Vision can read entire label columns
 * before values. Every label and typed value must exist independently; no
 * expected merchant data is used to reconstruct the table. */
function gcashBankFields(input: string[]) {
  const labels = [
    "Bank",
    "Account No.",
    "Account Name",
    "Transfer Method",
    "Receipt sent to",
    "Transfer Amount",
    "+Fee",
    "Total",
    "Date",
    "InstaPay Invoice No.",
    "Ref No.",
  ];
  const lines = input.flatMap((line) => {
    const label = labels.find((label) => (line.startsWith(label + ":") || line.startsWith(label + " ")) &&
      (label !== "Bank" || /^Bank[: ]+MariBank$/i.test(line)));
    return label
      ? [label, line.slice(label.length).replace(/^:/, "").trim()].filter(Boolean)
      : [line];
  });
  const positions = labels.map((label) => lines.indexOf(label));
  if (
    labels.some((label) => lines.filter((line) => line === label).length !== 1)
  ) return null;
  // Recipient and financial labels retain their own order even when their
  // columns are interleaved. Receipt email may precede the rail label.
  for (const indices of [[0, 1, 2], [5, 6, 7, 8, 9, 10]]) {
    if (
      indices.some((n, i) => i > 0 && positions[n] <= positions[indices[i - 1]])
    ) return null;
  }
  const values = lines.slice(positions[0] + 1).filter((line) =>
    !labels.includes(line) && !/^[✓✔☑]$/.test(line)
  );
  let i = 0;
  const bank = values[i++];
  if (!/^MariBank$/i.test(bank || "")) return null;
  const accounts: string[] = [];
  while (/^[\d*•●⚫·.xX\s]+$/.test(values[i] || "") && i < values.length) {
    accounts.push(values[i++]);
  }
  const validAccount = (s: string) =>
    /^(?:\d{11}|[*•●⚫·.xX]{2,}\d{4})$/.test(s.replace(/\s/g, ""));
  let account = accounts.join("").replace(/\s/g, "");
  if (!validAccount(account)) {
    // A duplicate OCR line may repeat the same masked suffix. Conflicting
    // visible digits never get discarded or replaced with configuration.
    if (
      accounts.length !== 2 || !validAccount(accounts[0]) ||
      !/^[*•●⚫·.xX]+\d{4}$/.test(accounts[1]) ||
      !/^[*•●⚫·.xX]+\d{4}$/.test(accounts[0]) ||
      accounts[0].slice(-4) !== accounts[1].slice(-4)
    ) {
      if (accounts.length !== 1 || !/^\d{4}$/.test(account)) return null;
      // Four digits alone do not prove a masked account: retain for review,
      // never synthesize missing mask glyphs or configured account digits.
    } else account = accounts[0];
  }
  const name = values[i++], method = values[i++];
  if (
    !/^[A-Za-z][A-Za-z .'-]+$/.test(name || "") ||
    !/^instapay$/i.test(method || "")
  ) return null;
  const emailParts: string[] = [];
  while (
    i < values.length && money(values[i]) === null && emailParts.length < 4
  ) emailParts.push(values[i++]);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailParts.join(""))) return null;
  const [principal, fee, totalRaw, dateRaw, invoiceRaw, referenceRaw] = values
    .slice(i, i + 6);
  if (
    money(principal) == null || money(fee) == null ||
    money(totalRaw?.replace(/^\+\s*/, "P")) == null ||
    !/^[A-Za-z]+ \d{1,2},?\s*\d{4} \d{1,2}:\d{2}(?::\d{2})? (?:AM|PM)$/i.test(
      dateRaw || "",
    ) ||
    !/^\d{4,20}$/.test(invoiceRaw || "") || !/^\d{13}$/.test(referenceRaw || "")
  ) return null;
  return {
    bank,
    account,
    name,
    method,
    principal,
    fee,
    totalRaw,
    dateRaw,
    invoiceRaw,
    referenceRaw,
  };
}
const GCASH_DATE = /^[A-Za-z]+ \d{1,2},?\s*\d{4} \d{1,2}:\d{2}(?::\d{2})? (?:AM|PM)$/i;
/** The ₱ glyph is often read as P, +, - or an arrow; a thousands separator
 * may be read as a period. Only used where principal + fee = total proves it. */
const GCASH_LENIENT_MONEY =
  /^(?:PHP|₱|P|\+|-|→|—|–)?\s*((?:\d{1,3}(?:[.,]\d{3})+|\d+)\.\d{2})$/i;
function lenientMoney(raw: string): number | null {
  const m = raw.match(GCASH_LENIENT_MONEY);
  if (!m) return null;
  const digits = m[1].replace(/[.,](?=\d{3}(?:[.,]|$))/g, "");
  return /^\d+\.\d{2}$/.test(digits) ? Number(digits) : null;
}
/**
 * Fallback for the GCash bank-transfer table when Vision splits labels
 * ("Account" / "Name ..."), emits values before their labels, or drops the
 * optional email. Each value is found by its own type and must be the only
 * one of its type; money roles are assigned only by exact principal + fee =
 * total. The recipient name must sit between the account and transfer method.
 * Expected merchant values never enter extraction; anything ambiguous → null.
 */
function gcashBankFieldsByType(input: string[]) {
  const inlineLabels = [
    "InstaPay Invoice No.",
    "Transfer Method",
    "Transfer Amount",
    "Receipt sent to",
    "Account Name",
    "Account No.",
    "Ref No.",
    "+Fee",
    "Total",
    "Date",
    "Name",
    "No.",
  ];
  const lines = input.flatMap((line) => {
    if (/^Bank[: ]+MariBank$/i.test(line)) return ["Bank", line.replace(/^Bank[: ]+/i, "")];
    const label = inlineLabels.find((label) => line.startsWith(label + " ") || line.startsWith(label + ":"));
    return label ? [label, line.slice(label.length).replace(/^:/, "").trim()].filter(Boolean) : [line];
  });
  const once = (label: string) => lines.filter((line) => line === label).length === 1;
  const none = (label: string) => !lines.includes(label);
  if (
    !["Bank", "Transfer Method", "Transfer Amount", "+Fee", "Total", "Date", "InstaPay Invoice No.", "Ref No."]
      .every(once)
  ) return null;
  // Every recipient label must be visible, whole or split by Vision into
  // "Account" + "Name" / "Account" + "No." (one shared "Account" word).
  const accountName = once("Account Name") && none("Name");
  const accountNo = once("Account No.") && none("No.");
  const splitName = once("Name") && none("Account Name");
  const splitNo = once("No.") && none("Account No.");
  const accountWords = lines.filter((line) => line === "Account").length;
  if (
    !((accountName && accountNo && accountWords === 0) ||
      (accountName && splitNo && accountWords === 1) ||
      (splitName && accountNo && accountWords === 1))
  ) return null;
  const only = (test: (line: string) => boolean) => {
    const found = lines.map((line, index) => ({ line, index })).filter(({ line }) => test(line));
    return found.length === 1 ? found[0] : null;
  };
  const bank = only((line) => /^MariBank$/i.test(line));
  const accountLine = only((line) =>
    /^(?:\d{11}|[*•●⚫·.xX][*•●⚫·.xX\s]*\d{4}(?:\s+\d{4})?)$/.test(line)
  );
  const methodLine = only((line) => /^insta ?pay$/i.test(line));
  const dateLine = only((line) => GCASH_DATE.test(line));
  const referenceLine = only((line) => /^\d{13}$/.test(line));
  // Not 11 digits: that is an unmasked MariBank account number.
  const invoiceLine = only((line) => /^\d{5,10}$/.test(line));
  if (!bank || !accountLine || !methodLine || !dateLine || !referenceLine || !invoiceLine) return null;
  // A repeated visible suffix ("....... • 7144 7144") is one account, never a longer one.
  const accountMatch = accountLine.line.match(/^(.*?)(\d{4})(?:\s+(\d{4}))?$/)!;
  if (accountMatch[3] && accountMatch[3] !== accountMatch[2]) return null;
  const account = (accountMatch[1] + accountMatch[2]).replace(/\s/g, "");
  if (!/^(?:\d{11}|[*•●⚫·.xX]{2,}\d{4})$/.test(account)) return null;
  const structural = new Set([
    ...inlineLabels, "Bank", "Account", "Bank Transfer", "Bank Transfer Complete",
    "Sent via GCash", "Download", "Share",
  ]);
  if (accountLine.index >= methodLine.index) return null;
  const names = lines.slice(accountLine.index + 1, methodLine.index).filter((line) =>
    !structural.has(line) && /^[A-Za-z][A-Za-z .'-]+$/.test(line)
  );
  if (names.length !== 1) return null;
  const amounts = lines.flatMap((line) => {
    const value = lenientMoney(line);
    return value === null ? [] : [{ line, value }];
  });
  if (amounts.length !== 3) return null;
  const cents = (value: number) => Math.round(value * 100);
  const [total, ...addends] = [...amounts].sort((a, b) => b.value - a.value);
  if (cents(addends[0].value) + cents(addends[1].value) !== cents(total.value)) return null;
  const [principal, fee] = addends;
  if (money(principal.line) === null || money(fee.line) === null || principal.value === fee.value) return null;
  return {
    bank: bank.line,
    account,
    name: names[0],
    method: methodLine.line,
    principal: principal.line,
    fee: fee.line,
    // The digits Vision observed; any misread currency glyph is not evidence.
    totalRaw: total.line.match(GCASH_LENIENT_MONEY)![1],
    totalValue: total.value,
    dateRaw: dateLine.line,
    invoiceRaw: invoiceLine.line,
    referenceRaw: referenceLine.line,
  };
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
  const additional = parseAdditionalMaribankReceipt(rawText, options.typedReference);
  if (additional) return additional;
  const lines = String(rawText || "").normalize("NFKC").split(/\r?\n/).map(
    (x) => x.replace(/\s+/g, " ").trim(),
  ).filter(Boolean).flatMap((line) => {
    // Normalize only the section label, never account/name/reference characters.
    line = line.replace(/^[TΤ][oο](?= |$)/, "To");
    const m = line.match(/^(From|To|Transfer Amount|Transfer Fee|Total Amount|Reference Number|Transaction Date & Time)\s+(\S.*)$/);
    return m ? [m[1], m[2]] : [line];
  });
  const text = lines.join("\n");
  // A screenshot cut off above "Sent via GCash" still shows the GCash body.
  // Every marker is required; the missing header and status keep it in review.
  const gcashBody = /\bin your GCash\b/i.test(text) &&
    /^Receipt sent to\b/m.test(text) && /^InstaPay Invoice No\./m.test(text) &&
    /^Powered by insta[PF]ay$/im.test(text);
  const source = /^Sent via GCash$/im.test(text) || gcashBody
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
  let gcashTypedTotal: number | null = null;
  let screenClock: MaribankScreenClock | null = null;
  if (source === "maribank") {
    let breakdownReference: string | null = null;
    let breakdownDate: string | null = null;
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
      // Geometric OCR may put the left-hand To label between the name and bank.
      const recipientLines = lines.slice(0, i).filter(s => s !== "To");
      const recipientBank = recipientLines.at(-1) || "";
      const recipientName = recipientLines.at(-2) || "";
      account = m![1];
      if (
        /^(?:M )?MariBank$/.test(recipientBank) &&
        /^(?:[•●◆] )?[A-Za-z][A-Za-z .'-]+$/.test(recipientName)
      ) {
        bank = recipientBank;
        name = recipientName;
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
        (!n || position > positions[n - 1])
      );
      const rowLayout = labels.every((label, n) =>
        lines[i + 1 + n * 2] === label
      );
      const interleaved = positions.every((position, n) => position >= 0 && (!n || position > positions[n - 1]));
      if (!columnLayout && !rowLayout && !interleaved) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
      if (
        money(values[0]) !== null &&
        /^(?:FREE|(?:PHP|₱|P)?\s*\d+\.\d{2})$/.test(values[1] || "") &&
        money(values[2]) !== null
      ) {
        [principal, fee, totalRaw] = values;
        breakdownReference = values[3] || null;
        breakdownDate = values[4] || null;
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
    if (
      di >= 0 && lines.filter((s) =>
          s === "Transaction Date & Time"
        ).length === 1 &&
      nativeTimestamp(dateRaw).completeness !== "date_time" &&
      nativeTimestamp(breakdownDate).completeness === "date_time"
    ) dateRaw = breakdownDate;
    if (di >= 0 && lines.filter(s => s === "Transaction Date & Time").length === 1) {
      const dates = lines.filter(s => nativeTimestamp(s).completeness === "date_time");
      dateRaw = dates.length === 1 ? dates[0] : null;
      if (dates.length > 1) issues.push("MARIBANK_TIMESTAMP_AMBIGUOUS");
    }
    // The "Transfer Result" screen prints no date. Its phone status bar clock
    // is the only time shown; keep it only when the receipt has no date row
    // at all and exactly one clock appears above the screen title.
    const title = lines.filter((s) => s === "Transfer Result").length === 1
      ? lines.indexOf("Transfer Result")
      : -1;
    if (
      title > 0 && di < 0 && !dateRaw &&
      !lines.some((s) =>
        nativeTimestamp(s).completeness !== "missing" || ANY_DATE.test(s)
      )
    ) {
      const clocks = lines.slice(0, title).flatMap((s) =>
        [...s.matchAll(STATUS_BAR_CLOCK)].map((m) => m[1])
      );
      if (clocks.length === 1) {
        const [hour, minute] = clocks[0].split(":").map(Number);
        screenClock = {
          raw: clocks[0],
          hour,
          minute,
          twelveHour: hour >= 1 && hour <= 12,
        };
      }
    }
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
    const typed = gcashBankFields(lines) ? null : gcashBankFieldsByType(lines);
    const fields = gcashBankFields(lines) || typed;
    if (typed) gcashTypedTotal = typed.totalValue;
    if (!fields) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
    if (fields) {
      ({
        bank,
        account,
        name,
        method,
        principal,
        fee,
        totalRaw,
        referenceRaw,
        invoiceRaw,
        dateRaw,
      } = fields);
    }
  }
  const transferAmount = money(principal),
    transferFee = money(fee),
    total = gcashTypedTotal ?? money(totalRaw?.replace(/^\+\s*/, "P") || null);
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
  const normalizedDate = dateRaw?.replace(/,(?=\d{4})/g, ", ") || null;
  const timestamp = source === "gcash"
    ? parseTimestamp(normalizedDate ? [normalizedDate] : [])
    : nativeTimestamp(dateRaw);
  // Date parser must consume the complete field, not accept a timestamp within unrelated text.
  if (
    source === "gcash" && dateRaw &&
    timestamp.raw?.trim() !== normalizedDate?.trim()
  ) issues.push("MARIBANK_TIMESTAMP_AMBIGUOUS");
  if (source === "gcash" && timestamp.completeness === "date_time") {
    timestamp.raw = dateRaw;
  }
  const statusRaw = source === "gcash"
    ? lines.find((s) => /^Bank Transfer Complete$/i.test(s))
    : lines.find((s) => /^Transfer Successful!$/i.test(s));
  // Owner policy: a GCash screenshot cut off above the status line is
  // accepted when the complete transfer table verifies and nothing visible
  // says pending or failed. Every payment field below still needs evidence.
  const headerCropped = source === "gcash" && !statusRaw &&
    !status.failureStatus && !status.pendingStatus;
  const sentViaGcash = lines.find((s) => /^Sent via GCash$/i.test(s));
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
    screenClock,
    paymentFields: {
      reference: referenceRaw,
      // A no-date MariBank screen proves its time with the status-bar clock.
      ...(screenClock
        ? { screenClock: screenClock.raw }
        : { dateTime: timestamp.raw }),
      amount: principal,
      fee,
      total: totalRaw,
      // Profile and bank logos can be read as a bullet or M. Retain them in
      // recipient raw fields, but measure confidence in the actual name/bank.
      recipientName: source === "maribank" ? name?.replace(/^[•●◆] /, "") : name,
      recipientAccount: account,
      destination: source === "maribank" ? bank?.replace(/^M /, "") : bank,
      // A cropped header has no status or source text to measure.
      ...(headerCropped ? {} : { status: statusRaw || null }),
      ...(source === "gcash"
        ? {
          secondaryReference: invoiceRaw,
          ...(sentViaGcash || !headerCropped ? { source: "Sent via GCash" } : {}),
          rail: method,
        }
        : {}),
    },
    indicators: {
      providerBrand: source === "gcash" ||
        (/\bMariBank\b/.test(text) && /^Transfer Result$/m.test(text)),
      competingProviderBrand: source === "maribank" &&
        /GoTyme|Sent via BPI|Security Bank/i.test(text),
      transferSuccess: (!!statusRaw || headerCropped) &&
        !status.failureStatus && !status.pendingStatus,
      headerCropped,
      destinationMaribank: /^(?:M )?MariBank$/.test(bank || ""),
      instaPay: /^instapay$/i.test(method || ""),
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
  const recipientComparison = parsed.source === "gotyme" && maskedMaribankNameMatches(parsed.recipient.nameRaw, context.expectedRecipientName || "") ? "initial_compatible" : compareName(
    parsed.recipient.nameRaw,
    context.expectedRecipientName || "",
  );
  const bpiShortAccount = parsed.source === "bpi" && /^[xX*•]{8}\d{3}$/.test(parsed.recipient.accountRaw || "") && /^\d{11}$/.test(context.expectedRecipientNumber || "") && context.expectedRecipientNumber!.endsWith(parsed.recipient.accountRaw!.slice(-3));
  const recipientAccountComparison = bpiShortAccount ? "suffix_match" : parsed.source === "gcash" && /^\d{4}$/.test(parsed.recipient.accountRaw || "") ? "missing" : compareAccount(
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
  const screenClock = "screenClock" in parsed ? parsed.screenClock : null;
  const clockCheck = screenClock
    ? checkMaribankScreenClock(parsed, screenClock, context)
    : null;
  if (clockCheck) {
    if (!clockCheck.accepted) add("TIME_UNREADABLE");
  } else if (
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
  if ((parsed.source === "bpi" || parsed.source === "gotyme") && parsed.reference.value) {
    dedupeKeys.push({key: parsed.source + ':' + parsed.reference.value, providerKey: parsed.source, duplicateFlag: 'DUPLICATE_REF'});
    if (parsed.secondaryReference) dedupeKeys.push({key: (parsed.source === 'bpi' ? 'bpi_transaction:' : 'instapay:') + parsed.secondaryReference, providerKey: parsed.source === 'bpi' ? 'bpi_transaction' : 'instapay', duplicateFlag: 'DUPLICATE_INSTAPAY_REF'});
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
    timeBasis: clockCheck?.accepted
      ? "reference_order_and_screen_clock" as const
      : "receipt_timestamp" as const,
    ...(clockCheck ? { screenClockCheck: clockCheck } : {}),
  };
}

/** Upper bound for the first submission of a no-date MariBank screenshot. */
export const MARIBANK_CLOCK_SUBMISSION_MINUTES = 30;

/** Owner policy (2026-11-09): MariBank's "Transfer Result" screen prints no
 * date. It may stand in for one only when all three hold:
 * 1. its BC reference is above every MariBank reference claimed at the court
 *    before this booking (references were observed to rise with time), so an
 *    older genuine screenshot cannot pass;
 * 2. the phone's status-bar clock falls in the payment window on the clock
 *    face (12-hour clocks compare modulo 12 hours);
 * 3. this exact image was first submitted shortly after the booking started.
 * Any missing input fails closed. */
export function checkMaribankScreenClock(
  parsed: { reference: { value: string | null } },
  clock: MaribankScreenClock,
  context: ReceiptVerificationContext & { now?: string },
) {
  const reasons: string[] = [];
  const reference = parsed.reference.value || "";
  const prior = context.maribankRecency?.priorReference || "";
  if (!context.maribankRecency) reasons.push("recency_unavailable");
  else if (!/^BC\d{18}$/.test(prior)) reasons.push("no_prior_reference");
  else if (!/^BC\d{18}$/.test(reference) || reference <= prior) {
    reasons.push("reference_not_newer");
  }
  const start = Date.parse(context.bookingStartedAt || "");
  let clockMinutes: number | null = null;
  if (!Number.isFinite(start)) reasons.push("booking_time_missing");
  else {
    // Philippine wall clock (UTC+8, no daylight saving).
    const wall = new Date(start + 8 * 3600_000);
    const startMinute = wall.getUTCHours() * 60 + wall.getUTCMinutes() +
      wall.getUTCSeconds() / 60;
    const cycle = clock.twelveHour ? 720 : 1440;
    const face = (clock.hour % (cycle / 60)) * 60 + clock.minute;
    let diff = ((face - startMinute) % cycle + cycle) % cycle;
    if (diff > cycle / 2) diff -= cycle;
    clockMinutes = Math.round(diff * 10) / 10;
    // The booking start keeps its seconds, so a payment in the booking's own
    // minute is less than one minute "early" on the clock face.
    if (
      diff < -context.earlyToleranceMinutes ||
      diff > context.paymentWindowMinutes
    ) reasons.push("clock_outside_window");
  }
  const submitted = Date.parse(context.maribankRecency?.firstSubmittedAt || "");
  if (!Number.isFinite(submitted) || !Number.isFinite(start)) {
    reasons.push("submission_time_missing");
  } else {
    const age = (submitted - start) / 60000;
    if (
      age < -context.earlyToleranceMinutes ||
      age > MARIBANK_CLOCK_SUBMISSION_MINUTES
    ) reasons.push("submitted_late");
  }
  return {
    accepted: reasons.length === 0,
    reasons,
    clock: clock.raw,
    clockMinutesAfterBooking: clockMinutes,
    reference: reference || null,
    priorReference: prior || null,
  };
}
export type MaribankDirectReceiptVerificationEvidence = ReturnType<
  typeof verifyMaribankDirectReceipt
>;
