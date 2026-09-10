export type ReceiptTransferStatus = {
  failureStatus: boolean;
  pendingStatus: boolean;
};

// Negative status is independent of a provider's positive completion heading.
// A receipt can retain "Sent" or "Transfer successful" after a later reversal;
// OCR recovery must never let that heading override the visible adverse state.
export function readReceiptTransferStatus(
  rawText: string,
): ReceiptTransferStatus {
  const text = String(rawText || "").normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ");
  return {
    failureStatus:
      /\b(?:failed|failure|declined|rejected|cancelled|canceled|unsuccessful|reversed|refunded)\b|\bnot\s+(?:successful|completed?|sent|transferred)\b/i
        .test(text),
    pendingStatus:
      /\b(?:pending|in\s+progress|scheduled|queued|on\s+hold|awaiting\s+(?:confirmation|approval|completion))\b/i
        .test(text) ||
      // "Processing time: Instant" and "Processing fee" are labels, not
      // pending transaction states. A separate "Pending" still vetoes them.
      /\bprocessing\b(?!\s+(?:time|fee)\b)/i.test(text),
  };
}
