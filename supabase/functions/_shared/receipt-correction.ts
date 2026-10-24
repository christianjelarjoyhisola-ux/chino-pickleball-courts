// Replacement never approves a payment: the new evidence goes through the
// ordinary verifier. The caller must already hold the booking token/staff role.
export function canReplaceIncompleteReceipt(
  row: Record<string, unknown>, expectedHash: unknown, provider: unknown,
): boolean {
  const flags = Array.isArray(row.receipt_flags) ? row.receipt_flags.map(String) : [];
  return row.status === "pending" && row.payment_status === "for_verification" &&
    row.receipt_status === "manual_review" && !!row.receipt_image_url &&
    /^[a-f0-9]{64}$/.test(String(expectedHash || "")) &&
    row.receipt_image_hash === expectedHash && row.payment_method === provider &&
    flags.some(flag => /UNREADABLE|LOW_OCR_CONFIDENCE|OCR_FAILED|OCR_UNAVAILABLE/.test(flag)) &&
    !flags.some(flag => /DUPLICATE|TAMPER|REUSED|ACCOUNT_MISMATCH|RECIPIENT_MISMATCH/.test(flag));
}
