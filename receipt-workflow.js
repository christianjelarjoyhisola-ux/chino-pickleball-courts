(function (root) {
  'use strict';
  function state(row) {
    const pay = row.paymentStatus, status = row.status;
    if (!['gcash','bdopay','maya','bpi','gotyme','maribank','pnb','securitybank'].includes(row.paymentMethod)) return null;
    if (!['pending', 'verifying'].includes(status) || ['paid', 'downpayment_paid', 'rejected', 'deposit_retained'].includes(pay)) return null;
    if (!row.receiptImageUrl) return { code: 'awaiting_payment', label: 'Awaiting payment', message: 'No receipt has been submitted. This is not a confirmed booking.' };
    const flags = row.receiptFlags || [];
    if (row.receiptStatus === 'manual_review' && flags.some(flag => /UNREADABLE|LOW_OCR_CONFIDENCE|OCR_FAILED|OCR_UNAVAILABLE/.test(flag))) {
      return { code: 'receipt_correction', label: 'Receipt needs correction', message: 'Upload a complete, clear receipt showing the recipient, amount, bank reference, and transaction date/time. Do not pay again.' };
    }
    return { code: 'manual_review', label: 'Awaiting owner review', message: 'Your receipt is stored and awaiting verification. Do not pay again.' };
  }
  // A signed URL can succeed while the image request fails. Retry with a new
  // URL and give the operator an explicit retry instead of an empty image.
  async function showImage({ image, link, message, getUrl, isCurrent }) {
    image.removeAttribute('src');
    link.style.display = 'none';
    message.style.display = '';
    message.textContent = 'Loading receipt image…';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = await getUrl();
        if (!isCurrent()) return;
        await new Promise((resolve, reject) => {
          const preview = new Image();
          const timer = setTimeout(() => finish(new Error('Image timed out')), 15000);
          function finish(error) { clearTimeout(timer); preview.onload = preview.onerror = null; error ? reject(error) : resolve(); }
          preview.onload = () => finish();
          preview.onerror = () => finish(new Error('Image could not load'));
          preview.src = url;
        });
        if (!isCurrent()) return;
        image.src = url; link.href = url; link.style.display = ''; message.style.display = 'none';
        return;
      } catch (_) { if (!isCurrent()) return; }
    }
    message.textContent = 'The receipt is stored, but its image could not be loaded. ';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'btn btn-sm'; retry.textContent = 'Retry image';
    retry.onclick = () => { if (isCurrent()) void showImage({ image, link, message, getUrl, isCurrent }); };
    message.append(retry);
  }
  root.ReceiptWorkflow = { state, showImage };
  if (typeof module === 'object') module.exports = root.ReceiptWorkflow;
})(typeof window === 'object' ? window : globalThis);
