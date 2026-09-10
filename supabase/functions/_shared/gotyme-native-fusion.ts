import type { GoogleVisionOcrResult } from "./google-vision.ts";
import {
  type BankApprovalConfidence,
  bankApprovalConfidence,
  bankFieldIdentity,
  bankLayoutFamily,
  bankOcrText,
  type BankPaymentFieldEvidence,
  type BankProviderParse,
  bankReceiptHasIncompleteStatus,
  partitionBankPaymentFields,
} from "./bank-ocr-evidence.ts";
import {
  parseProviderReceipt,
  type ReceiptVerificationContext,
  verifyProviderReceipt,
} from "./receipt-providers/index.ts";

export type GotymeNativeFusionInput = {
  original: { read: GoogleVisionOcrResult; parsed: BankProviderParse };
  candidates: Array<
    {
      strategy: string;
      read: GoogleVisionOcrResult;
      parsed: BankProviderParse;
      approval?: BankApprovalConfidence;
    }
  >;
  context: ReceiptVerificationContext;
};
const score = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum &&
  value <= 1;
function sameField(
  key: string,
  a: BankPaymentFieldEvidence | undefined,
  b: BankPaymentFieldEvidence | undefined,
  ap: BankProviderParse,
  bp: BankProviderParse,
): boolean {
  return key === "dateTime"
    ? !!ap.receipt.timestamp.instant &&
      ap.receipt.timestamp.instant === bp.receipt.timestamp.instant
    : !!a?.text && !!b?.text &&
      bankFieldIdentity(key, a.text) === bankFieldIdentity(key, b.text);
}

function reparseRetainedFinancialRows(
  original: GoogleVisionOcrResult,
  candidate: GoogleVisionOcrResult,
  context: ReceiptVerificationContext,
): BankProviderParse | null {
  const originalLines = bankOcrText(original).split(/\r?\n/),
    candidateLines = bankOcrText(candidate).split(/\r?\n/);
  const amountRow = (lines: string[]) => {
    const indexes = lines.map((line, index) =>
      /^(?:transfer\s+)?amount\b/i.test(line.trim()) ? index : -1
    ).filter((index) => index >= 0);
    if (indexes.length !== 1) return null;
    const start = indexes[0];
    const standaloneLabel = /^(?:transfer\s+)?amount\s*[:\-]?\s*$/i.test(
      lines[start].trim(),
    );
    const followingValue = standaloneLabel &&
      /^(?:PHP|[₱P$])?\s*[\dO.,]+\s*$/i.test((lines[start + 1] || "").trim());
    return { start, count: followingValue ? 2 : 1 };
  };
  const from = amountRow(originalLines), to = amountRow(candidateLines);
  if (!from || !to) return null;
  // The replacement is verbatim observed OCR. Every original header, fee and
  // total remains for the dedicated parser's principal/fee/total checks.
  originalLines.splice(
    from.start,
    from.count,
    ...candidateLines.slice(to.start, to.start + to.count),
  );
  return parseProviderReceipt("gotyme", originalLines.join("\n"), {
    typedReference: context.typedReference,
  }) as BankProviderParse;
}

/** Recover only missing principal evidence from whole Google reads. Every other
 * parsed value stays original; native confidence is selected by matching value,
 * never by merchant expectations. A weak account remains weak and reviewable. */
export function recoverGotymeNativeFields(input: GotymeNativeFusionInput) {
  const reads = [
    { id: "original", read: input.original.read },
    ...input.candidates.map((candidate, index) => ({
      id: `${candidate.strategy}:${index}`,
      read: candidate.read,
    })),
  ]
    .map((item) => {
      const parsed = parseProviderReceipt("gotyme", bankOcrText(item.read), {
        typedReference: input.context.typedReference,
      }) as BankProviderParse;
      const evidence = bankApprovalConfidence(item.read, parsed, input.context);
      return {
        ...item,
        parsed,
        evidence,
        allFields: { ...evidence.optionalFields, ...evidence.fields },
        eligible: item.read.confidenceSource === "native" &&
          !!item.read.nativeLines?.length &&
          bankLayoutFamily("gotyme", bankOcrText(item.read)) ===
            "gotyme_transferred_v1",
      };
    });
  const original = reads[0],
    parsed = structuredClone(original.parsed),
    conservationFlags: string[] = [];
  const add = (flag: string) => {
    if (!conservationFlags.includes(flag)) conservationFlags.push(flag);
  };
  if (!original.eligible || input.original.parsed.provider !== "gotyme") {
    add("NATIVE_FUSION_LAYOUT_UNSUPPORTED");
  }
  if (
    reads.some((item) =>
      bankReceiptHasIncompleteStatus(item.read.text) ||
      bankReceiptHasIncompleteStatus(bankOcrText(item.read))
    )
  ) add("PAYMENT_STATUS_NOT_COMPLETED");
  if (
    reads.some((item) => item.parsed.receipt.indicators.competingProviderBrand)
  ) add("METHOD_MISMATCH");
  let amountSource = original;
  if (
    parsed.receipt.amount.amount == null || !parsed.receipt.amount.reliable ||
    parsed.receipt.amount.ambiguous
  ) {
    const candidate = reads.slice(1).find((item) =>
      item.eligible && item.parsed.receipt.amount.amount != null &&
      item.parsed.receipt.amount.reliable &&
      !item.parsed.receipt.amount.ambiguous &&
      score(item.evidence.fields.amount?.confidence, .9)
    );
    if (candidate) {
      const recomposed = reparseRetainedFinancialRows(
        original.read,
        candidate.read,
        input.context,
      );
      if (!recomposed) add("NATIVE_AMOUNT_LAYOUT_UNSUPPORTED");
      else {
        amountSource = candidate;
        parsed.receipt.amount = structuredClone(recomposed.receipt.amount);
        if (
          !parsed.receipt.amount.reliable || parsed.receipt.amount.ambiguous ||
          parsed.receipt.amount.amount !==
            candidate.parsed.receipt.amount.amount
        ) add("ORIGINAL_FINANCIAL_ROWS_CONFLICT");
      }
    }
  }
  const desired = { ...original.allFields };
  for (const key of Object.keys(desired).filter((key) => /^amount/.test(key))) {
    delete desired[key];
  }
  for (
    const [key, field] of Object.entries(amountSource.allFields).filter((
      [key],
    ) => /^amount/.test(key))
  ) desired[key] = field;
  // Retain optional financial observations for conservation. The server-owned
  // name-only policy excludes only account identity from recipient decisions;
  // its original account observation remains unchanged in the audit.
  for (const item of reads) {
    if (item.read.confidenceSource !== "native") continue;
    for (const [key, field] of Object.entries(item.allFields)) {
      if (
        key === "recipientAccount" &&
        input.context.gotymeRecipientPolicy === "masked_name_only"
      ) continue;
      if (
        !field.text ||
        !(score(field.confidence, .9) ||
          field.occurrenceConfidences?.some((value) => score(value, .9)))
      ) continue;
      // A missing unchanged field remains missing; it is not a contradictory
      // observation and still prevents a clean final verification below.
      if (!desired[key]?.text) continue;
      if (!sameField(key, field, desired[key], item.parsed, parsed)) {
        add(`STRONG_GOOGLE_${key.toUpperCase()}_CONFLICT`);
      }
    }
  }
  const usedFields: Record<
    string,
    BankPaymentFieldEvidence & { readId: string | null }
  > = {};
  for (const [key, field] of Object.entries(desired)) {
    // This bounded recovery repairs principal only. A weak/missing original
    // account is never upgraded by another read or any other field's score.
    if (key === "recipientAccount") {
      usedFields[key] = {
        ...field,
        readId: score(field.confidence) ? "original" : null,
      };
      continue;
    }
    const matches = reads.filter((item) =>
      item.eligible &&
      sameField(key, item.allFields[key], field, item.parsed, parsed)
    );
    const selected = matches.find((item) =>
      score(item.allFields[key].confidence, .9)
    ) || matches.find((item) => score(item.allFields[key].confidence));
    usedFields[key] = selected
      ? { ...selected.allFields[key], readId: selected.id }
      : { ...field, readId: null };
  }
  const observed = Object.fromEntries(
    Object.entries(usedFields).map((
      [key, { readId: _readId, ...field }],
    ) => [key, field]),
  );
  // Re-evaluate after principal recovery: a genuinely observed exact zero fee
  // can be optional only once native principal and retained total reconcile.
  const { fields, optionalFields } = partitionBankPaymentFields(
    parsed,
    input.context,
    observed,
  );
  const complete = Object.keys(fields).length > 0 &&
    Object.values(fields).every((field) => score(field.confidence));
  const approval: BankApprovalConfidence = {
    fields,
    optionalFields,
    complete,
    confidence: complete
      ? Math.min(...Object.values(fields).map((field) => field.confidence!))
      : 0,
    source: complete ? "bank_payment_fields" : "none",
    basis: complete
      ? "native_payment_value_words"
      : "missing_native_payment_evidence",
  };
  const safeToUse = conservationFlags.length === 0;
  const selectedParsed = safeToUse ? parsed : original.parsed;
  const selectedApproval = safeToUse ? approval : original.evidence;
  const verification = verifyProviderReceipt(selectedParsed, input.context);
  const flags = [
    ...new Set([
      ...conservationFlags,
      ...verification.flags,
      ...(!selectedApproval.complete || selectedApproval.confidence < .9
        ? ["LOW_OCR_CONFIDENCE"]
        : []),
    ]),
  ];
  return {
    safeToUse,
    applied: safeToUse &&
      (amountSource.id !== "original" ||
        Object.values(usedFields).some((field) =>
          field.readId && field.readId !== "original"
        )),
    parsed: selectedParsed,
    approval: selectedApproval,
    usedFields,
    flags,
    conservationFlags,
    verification,
    recoveredFields: safeToUse && amountSource.id !== "original"
      ? ["amount"]
      : [],
    originalEvidence: original.evidence,
    cleanBeforeDuplicateCheck: safeToUse && flags.length === 0 &&
      selectedApproval.complete && selectedApproval.confidence >= .9,
    requiresCallerDuplicateCheck: true as const,
  };
}
