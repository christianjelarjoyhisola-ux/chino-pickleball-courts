import { extractReceiptAmount } from "../receipt-amount.ts";
import { readReceiptTransferStatus } from "./transfer-status.ts";
import { parseBpiToGcashReceipt } from "./bpi.ts";
import {
  normalizeGotymeMaskFragments,
  parseGotymeToGcashReceipt,
} from "./gotyme.ts";
import { parseTimestamp } from "./securitybank.ts";

// These are destination-specific formats. Sender branding is not evidence of
// a wrong destination. Extraction never receives configured account details.
export function parseAdditionalMaribankReceipt(
  raw: string,
  typedReference = "",
) {
  const lines = normalizeGotymeMaskFragments(raw).normalize("NFKC").split(
    /\r?\n/,
  ).map((s) =>
    s.replace(/\s+/g, " ").trim().replace(/^[ΤT][οo](?=\s|$)/, "To").replace(
      /^(To )?[•●◆→]\s*/,
      "$1",
    )
  ).filter(Boolean);
  const text = lines.join("\n");
  const source = /^Sent via BPI$/im.test(text)
    ? "bpi" as const
    : /\bGoTyme Bank\b/i.test(text)
    ? "gotyme" as const
    : /^Transaction Receipt$/im.test(text) &&
        /^Receipt generated from MariBank app$/im.test(text)
    ? "maribank" as const
    : null;
  if (!source) return null;
  const issues: string[] = [];
  const unique = (values: string[]) => {
    if (values.length > 1) issues.push("MARIBANK_AMBIGUOUS_FIELDS");
    return values.length === 1 ? values[0] : null;
  };
  const field = (pattern: RegExp) =>
    unique(lines.flatMap((line, i) => {
      const m = line.match(pattern);
      return m ? [m[1]?.trim() || lines[i + 1] || ""] : [];
    }));
  const money = (s: string | null) =>
    s === "FREE"
      ? 0
      : /^(?:PHP|₱|P)?\s*(\d[\d,]*\.\d{2})$/i.test(s || "")
      ? Number(s!.replace(/^(?:PHP|₱|P)\s*/i, "").replaceAll(",", ""))
      : null;
  let name: string | null = null,
    account: string | null = null,
    bank: string | null = null;
  let principal: string | null = null,
    fee: string | null = null,
    totalRaw: string | null = null;
  let reference: string | null = null,
    secondary: string | null = null,
    statusRaw: string | null = null;
  let timestamp = parseTimestamp([]);
  const to = lines.findIndex((s) => /^(?:Transfer to|To)(?:\s|$)/i.test(s));
  const recipientBlock = to < 0 ? [] : lines.slice(
    to,
    lines.findIndex((s, i) =>
        i > to &&
        /^(?:From|Transfer from|Transfer Amount|Amount)(?:\s|$)/i.test(s)
      ) < 0
      ? to + 9
      : lines.findIndex((s, i) =>
        i > to &&
        /^(?:From|Transfer from|Transfer Amount|Amount)(?:\s|$)/i.test(s)
      ),
  );
  if (source === "bpi") {
    const existing = parseBpiToGcashReceipt(
      text.replace(/(\d{4});(?=\s+\d{1,2}:)/g, "$1,"),
    );
    if (existing.timestamp.raw) {
      existing.timestamp.raw = existing.timestamp.raw.replace(
        /(\d{4}),(?=\s+\d{1,2}:)/,
        (_, year) => text.includes(year + ";") ? year + ";" : year + ",",
      );
    }
    timestamp = existing.timestamp;
    reference = existing.reference.value;
    secondary = existing.transactionReference.value;
    name = unique(recipientBlock.filter((s) =>
      /\(QR Code\)$/i.test(s)
    ))?.replace(/\s*\(QR Code\)$/i, "") || null;
    account = unique(recipientBlock.filter((s) =>
      /^(?:[xX*•]{2,}\d{3,4}|\d{11})$/.test(s.replaceAll(" ", ""))
    ));
    const bankLines = recipientBlock.filter((s) =>
      /MARIBANK|RURAL BANK/i.test(s)
    );
    bank = bankLines.length ? bankLines.join(" ") : null;
    principal = field(/^Transfer amount\s*(.*)$/i);
    fee = field(/^Fee\s*(.*)$/i);
    statusRaw = unique(lines.filter((s) =>
      /^Transfer successful!$/i.test(s)
    ));
    if (!secondary) {
      issues.push("BPI_TRANSACTION_REF_UNREADABLE");
    }
  } else if (source === "gotyme") {
    const existing = parseGotymeToGcashReceipt(text);
    if (!/From[\s\S]*GoTyme Bank/i.test(text)) {
      issues.push("MARIBANK_SOURCE_UNREADABLE");
    }
    timestamp = existing.timestamp;
    reference = existing.reference.value;
    secondary = existing.railReference.value;
    const names = recipientBlock.flatMap((s) =>
      /^To\s+(.+)$/i.test(s)
        ? [s.replace(/^To\s+/i, "")]
        : /^[A-Z][A-Z .*'-]+$/.test(s) && s !== "To" && !/BANK/i.test(s)
        ? [s]
        : []
    );
    name = unique(names);
    account = unique(recipientBlock.filter((s) =>
      /^(?:[*•xX.]{2,}\d{4}|\d{11})$/.test(s.replaceAll(" ", ""))
    ))?.replaceAll(" ", "") || null;
    bank = unique(recipientBlock.filter((s) =>
      /^MariBank Philippines(?: \(SeaBank\))?$/i.test(s)
    ));
    principal = field(/^Amount\s*(.*)$/i);
    fee = field(/^Fee\s*(.*)$/i);
    totalRaw = field(/^Total\s*(.*)$/i);
    statusRaw = unique(lines.filter((s) =>
      /^Transferred$/i.test(s)
    ));
    const headline = field(/^Transferred\s*(.*)$/i);
    if (money(headline) !== money(principal)) {
      issues.push("MARIBANK_AMOUNT_CONFLICT");
    }
    if (!/^insta\s*[pf]ay(?: Instant)?$/im.test(text)) {
      issues.push("INSTAPAY_QRPH_UNREADABLE");
    }
    if (!secondary) {
      issues.push("GOTYME_TRACE_ID_UNREADABLE");
    }
  } else {
    // Downloaded transaction receipts can omit fee/total entirely. Do not
    // invent either value; require the headline and labelled principal to agree.
    principal = field(/^Transfer Amount\s*(.*)$/i);
    fee = field(/^Transfer Fee\s*(.*)$/i);
    totalRaw = field(/^Total Amount\s*(.*)$/i);
    reference = field(/^(?:Reference Number|Transaction Number)\s*(.*)$/i);
    if (!/^BC\d{18}$/.test(reference || "")) reference = null;
    account = field(/^Acct\. No\.:\s*(.*)$/i);
    const ai = lines.findIndex((s) => /^Acct\. No\.:/.test(s));
    const pre = lines.slice(0, ai).filter((s) => s !== "To");
    bank = pre.at(-1) || null;
    name = pre.at(-2)?.replace(/^To\s+/, "") || null;
    const date = field(/^Transaction Date & Time\s*(.*)$/i);
    const m = date?.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4}), (\d{2}):(\d{2})$/);
    if (m && Number(m[4]) < 24 && Number(m[5]) < 60) {
      const h = Number(m[4]);
      timestamp = {
        ...parseTimestamp([
          `${m[2]} ${m[1]}, ${m[3]} ${h % 12 || 12}:${m[5]} ${
            h < 12 ? "AM" : "PM"
          }`,
        ]),
        raw: date,
      };
    }
    const title = lines.indexOf("Transaction Receipt");
    if (money(lines[title + 1] || null) !== money(principal)) {
      issues.push("MARIBANK_AMOUNT_CONFLICT");
    }
    if (
      lines.filter((s) => s === "To").length !== 1 &&
      !lines.some((s) => /^To\s+/.test(s))
    ) issues.push("MARIBANK_RECIPIENT_SECTION_UNREADABLE");
    if (!/^(?:M )?MariBank$/i.test(bank || "")) {
      issues.push("MARIBANK_DESTINATION_MISMATCH");
    }
    statusRaw = "Transaction Receipt";
  }
  const amount = money(principal),
    transferFee = money(fee),
    total = money(totalRaw);
  if (
    amount === null || (source !== "maribank" && transferFee === null) ||
    (source === "gotyme" && total === null)
  ) issues.push("MARIBANK_AMOUNT_BREAKDOWN_UNREADABLE");
  if (
    (fee !== null && transferFee === null) ||
    (totalRaw !== null && total === null)
  ) issues.push("MARIBANK_AMOUNT_BREAKDOWN_UNREADABLE");
  if (
    total !== null &&
    (transferFee === null || amount === null ||
      Math.round((amount + transferFee) * 100) !== Math.round(total * 100))
  ) issues.push("MARIBANK_TOTAL_MISMATCH");
  const adverse = readReceiptTransferStatus(text);
  const typed = typedReference.replace(/\s/g, "").toUpperCase();
  return {
    provider: "maribank_direct" as const,
    destinationProvider: "maribank" as const,
    parserVersion: "maribank_direct_v1" as const,
    source,
    reference: {
      value: reference,
      raw: reference,
      confidence: reference ? "high" as const : "low" as const,
      typedMatch: !typed
        ? "not_provided" as const
        : !reference
        ? "ocr_missing" as const
        : typed === reference
        ? "match" as const
        : "mismatch" as const,
    },
    invoice: { value: null, raw: null },
    amount: extractReceiptAmount(
      amount === null ? "" : `Amount PHP ${amount.toFixed(2)}`,
      { provider: "maribank" },
    ),
    transferFee,
    total,
    timestamp,
    recipient: { nameRaw: name, accountRaw: account, bankRaw: bank },
    paymentFields: {
      reference,
      dateTime: timestamp.raw,
      amount: principal,
      recipientName: name,
      recipientAccount: account,
      destination: source === "maribank"
        ? bank?.replace(/^M /, "") || null
        : bank,
      status: statusRaw,
      ...(fee !== null ? { fee } : {}),
      ...(totalRaw !== null ? { total: totalRaw } : {}),
      ...(source === "maribank"
        ? { source: "Receipt generated from MariBank app" }
        : source === "bpi"
        ? { source: "Sent via BPI", secondaryReference: secondary }
        : {
          source: "GoTyme Bank",
          rail: unique(
            lines.filter((s) => /^insta\s*[pf]ay(?: Instant)?$/i.test(s)),
          ),
          secondaryReference: secondary,
        }),
    } as Record<string, string | null>,
    indicators: {
      providerBrand: true,
      competingProviderBrand: source === "bpi"
        ? /GoTyme|Sent via GCash/i.test(text)
        : source === "gotyme"
        ? /Sent via BPI|Sent via GCash/i.test(text)
        : /Sent via BPI|GoTyme|Sent via GCash/i.test(text),
      transferSuccess: !!statusRaw && !adverse.failureStatus &&
        !adverse.pendingStatus,
      destinationMaribank: source === "bpi"
        ? /^MARIBANK PHILIPPINES INC\. \(A RURAL BANK\)$/i.test(bank || "")
        : /^(?:M )?MariBank(?: Philippines(?: \(SeaBank\))?)?$/i.test(
          bank || "",
        ),
      instaPay: /insta\s*pay/i.test(text),
      ...adverse,
    },
    issues: [...new Set(issues)],
    secondaryReference: secondary,
  };
}

export function maskedMaribankNameMatches(
  raw: string | null,
  expected: string,
): boolean {
  if (!raw || !raw.includes("*")) return false;
  const parts = raw.toUpperCase().trim().split(/\s+/),
    full = expected.toUpperCase().trim().split(/\s+/);
  return parts.length === full.length && parts[0].length >= 3 &&
    parts[0] === full[0] &&
    parts.every((part, i) =>
      /^[A-Z]+\**$/.test(part) &&
      (part.endsWith("*")
        ? full[i].startsWith(part.replace(/\*+$/, ""))
        : full[i] === part)
    );
}
