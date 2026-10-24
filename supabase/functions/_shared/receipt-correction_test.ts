import { canReplaceIncompleteReceipt } from './receipt-correction.ts';
const hash = 'a'.repeat(64);
const row = { status: 'pending', payment_status: 'for_verification', payment_method: 'maribank', receipt_status: 'manual_review', receipt_image_url: 'ref/receipt.png', receipt_image_hash: hash, receipt_flags: ['REF_UNREADABLE'] };
Deno.test('incomplete receipt can be corrected with exact current evidence and provider', () => {
  if (!canReplaceIncompleteReceipt(row, hash, 'maribank')) throw new Error('expected correction');
  for (const change of [
    { status: 'cancelled' }, { status: 'confirmed' }, { status: 'completed' },
    { payment_status: 'paid' }, { payment_status: 'downpayment_paid' },
    { receipt_status: 'auto_approved' }, { receipt_status: 'rejected' },
    { receipt_image_url: null }, { receipt_flags: [] },
    { receipt_flags: ['REF_UNREADABLE', 'DUPLICATE_REFERENCE'] },
    { receipt_flags: ['REF_UNREADABLE', 'RECIPIENT_MISMATCH'] },
  ]) if (canReplaceIncompleteReceipt({ ...row, ...change }, hash, 'maribank')) throw new Error(JSON.stringify(change));
  if (canReplaceIncompleteReceipt(row, 'b'.repeat(64), 'maribank')) throw new Error('stale hash');
  if (canReplaceIncompleteReceipt(row, hash, 'gcash')) throw new Error('wrong provider');
});
