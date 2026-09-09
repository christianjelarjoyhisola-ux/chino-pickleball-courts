(() => {
  'use strict';
  // Payment consent is scoped to one reservation; legacy poster consent is ignored.
  const storageKey = 'chino-court-policies:payment:2026-09-09-v2';
  let bookingRef = '';
  let accepted = false;
  let syncing = false;
  let shown = false;
  let previousRootOverflow = '';
  let previousBodyOverflow = '';
  let reviewTrigger = null;
  let pendingDecision = null;
  let textLoaded = false;
  let textLoading = null;
  const agreement = document.getElementById('courtPoliciesAgree');
  const dialog = document.createElement('dialog');
  dialog.className = 'court-policies-dialog';
  dialog.setAttribute('aria-labelledby', 'courtPoliciesTitle');
  dialog.setAttribute('aria-describedby', 'courtPoliciesTextIntro');
  dialog.innerHTML = `
    <header class="court-policies-review-heading">
      <span>CHINO Pickleball Courts</span>
      <h2 id="courtPoliciesTitle" tabindex="-1">Court policies</h2>
      <p id="courtPoliciesTextIntro">Please review before continuing to payment.</p>
      <button type="button" class="court-policies-close" aria-label="Close court policies">×</button>
    </header>
    <div class="court-policies-text" tabindex="0" role="region" aria-label="Court policies text"></div>
    <footer class="court-policies-actions">
      <div class="court-policies-buttons">
        <button type="button" class="court-policies-agree">Agree &amp; Continue</button>
      </div>
    </footer>`;
  document.body.append(dialog);
  const textView = dialog.querySelector('.court-policies-text');
  const title = dialog.querySelector('#courtPoliciesTitle');
  const agreeButton = dialog.querySelector('.court-policies-agree');
  const closeButton = dialog.querySelector('.court-policies-close');

  function canAgree() { return !!bookingRef && !!agreement && !agreement.disabled; }
  function updateButton() {
    const readOnly = accepted || !canAgree();
    agreeButton.textContent = readOnly ? 'Close' : 'Agree & Continue';
    agreeButton.disabled = !readOnly && !textLoaded;
  }
  function saveAcceptance(value) {
    accepted = !!value && !!bookingRef;
    try {
      if (accepted) sessionStorage.setItem(storageKey, JSON.stringify({ bookingRef, accepted: true }));
      else sessionStorage.removeItem(storageKey);
    } catch (_) {}
    updateButton();
  }
  function syncPaymentAgreement() {
    if (!agreement || agreement.disabled || agreement.checked === accepted) return;
    syncing = true;
    try {
      agreement.checked = accepted;
      agreement.dispatchEvent(new Event('change', { bubbles: true }));
    } finally { syncing = false; }
  }
  function finishDecision(result) {
    const pending = pendingDecision;
    pendingDecision = null;
    const wasShown = shown;
    shown = false;
    if (dialog.open) dialog.close();
    if (wasShown) {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      const trigger = reviewTrigger;
      reviewTrigger = null;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    }
    pending?.resolve(!!result);
  }
  function dismiss() { finishDecision(false); }
  function loadPolicyText() {
    if (textLoaded) return Promise.resolve();
    if (textLoading) return textLoading;
    textView.innerHTML = '<p class="court-policies-load" role="status">Loading court policies…</p>';
    updateButton();
    textLoading = Promise.resolve().then(async () => {
      try {
        const response = await fetch('court-policies.html?v=20260909-payment-policies-v2');
        if (!response.ok) throw new Error('Policy text unavailable');
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const content = page.getElementById('courtPoliciesText');
        if (!content || !content.querySelector('ol')) throw new Error('Policy text missing');
        textView.innerHTML = content.innerHTML;
        textLoaded = true;
      } catch (_) {
        textView.innerHTML = '<div class="court-policies-load" role="status"><p>We couldn’t load the policies. Please try again.</p><button type="button" class="court-policies-retry">Try again</button><a href="court-policies.html" target="_blank" rel="noopener">Open text in a new tab ↗</a></div>';
      } finally {
        textLoading = null;
        // A late response only fills the text cache. It cannot reopen or accept.
        if (shown && dialog.open) updateButton();
      }
    });
    return textLoading;
  }
  function showPolicies(trigger) {
    if (dialog.open) return true;
    reviewTrigger = trigger || document.activeElement;
    previousRootOverflow = document.documentElement.style.overflow;
    previousBodyOverflow = document.body.style.overflow;
    updateButton();
    try { dialog.showModal(); } catch (_) { finishDecision(false); return false; }
    shown = true;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    textView.scrollTop = 0;
    title.focus({ preventScroll: true });
    void loadPolicyText();
    return true;
  }
  function requestAgreement(trigger) {
    if (!canAgree()) return Promise.resolve(false);
    if (accepted) { syncPaymentAgreement(); return Promise.resolve(true); }
    if (pendingDecision) return pendingDecision.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pendingDecision = { promise, resolve };
    showPolicies(trigger);
    return promise;
  }
  function setBookingContext(ref) {
    const nextRef = typeof ref === 'string' ? ref.trim() : '';
    if (nextRef && nextRef === bookingRef) { syncPaymentAgreement(); return; }
    dismiss();
    bookingRef = nextRef;
    accepted = false;
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      accepted = !!bookingRef && stored?.bookingRef === bookingRef && stored?.accepted === true;
      if (!accepted) sessionStorage.removeItem(storageKey);
    } catch (_) {}
    syncPaymentAgreement();
    updateButton();
  }
  function resetAgreement() {
    dismiss();
    bookingRef = '';
    saveAcceptance(false);
    syncPaymentAgreement();
  }

  textView.addEventListener('click', event => {
    if (event.target.closest('.court-policies-retry') && dialog.open) void loadPolicyText();
  });
  closeButton.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => { if (shown && !dialog.open) dismiss(); });
  agreeButton.addEventListener('click', () => {
    if (!dialog.open || agreeButton.disabled) return;
    if (accepted || !canAgree()) { dismiss(); return; }
    if (!textLoaded) return;
    saveAcceptance(true);
    syncPaymentAgreement();
    finishDecision(true);
  });
  agreement?.addEventListener('change', () => {
    if (syncing || agreement.disabled) return;
    if (!agreement.checked) { saveAcceptance(false); return; }
    if (accepted) return;
    // Checkbox interaction opens the same review; only its Agree button grants consent.
    syncPaymentAgreement();
    void requestAgreement(agreement);
  });
  window.ChinoCourtPolicies = {
    setBookingContext,
    requestAgreement,
    review: showPolicies,
    open: showPolicies,
    dismiss,
    resetAgreement,
    syncPaymentAgreement,
    isOpen() { return dialog.open; },
  };
  syncPaymentAgreement();
})();
