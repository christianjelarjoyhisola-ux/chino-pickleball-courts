(() => {
  'use strict';
  const storageKey = 'chino-court-policies:2026-09-09';
  let accepted = false;
  let previousRootOverflow = '';
  let previousBodyOverflow = '';
  let reviewTrigger = null;
  let reviewing = false;
  try { accepted = sessionStorage.getItem(storageKey) === 'accepted'; } catch (_) {}
  const dialog = document.createElement('dialog');
  dialog.className = 'court-policies-dialog';
  dialog.setAttribute('aria-labelledby', 'courtPoliciesTitle');
  dialog.setAttribute('aria-describedby', 'courtPoliciesIntro');
  dialog.innerHTML = `
    <h2 class="court-policies-sr-only" id="courtPoliciesTitle">Court policies</h2>
    <p class="court-policies-sr-only" id="courtPoliciesIntro">Review the poster or text version. Selecting Agree &amp; Continue means you agree to these court policies.</p>
    <div class="court-policies-content">
      <a class="court-policies-poster" href="assets/court-policies.png" target="_blank" rel="noopener" aria-label="Enlarge court policies poster (opens in a new tab)">
        <img src="assets/court-policies.png" width="1024" height="1536" alt="CHINO court policies poster. Tap to enlarge, or use the text version below.">
      </a>
    </div>
    <footer class="court-policies-actions">
      <div class="court-policies-help">Tap to enlarge · <a href="court-policies.html" target="_blank" rel="noopener" aria-label="Read court policies as text (opens in a new tab)">Read as text ↗</a></div>
      <div class="court-policies-buttons">
        <button type="button" class="court-policies-agree">Agree &amp; Continue</button>
      </div>
    </footer>`;
  document.body.append(dialog);
  const agreement = document.getElementById('courtPoliciesAgree');
  function saveAcceptance(value) {
    accepted = value;
    try {
      if (accepted) sessionStorage.setItem(storageKey, 'accepted');
      else sessionStorage.removeItem(storageKey);
    } catch (_) {}
  }
  function syncPaymentAgreement() {
    if (!agreement || agreement.disabled) return;
    if (agreement.checked !== accepted) {
      agreement.checked = accepted;
      agreement.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  agreement?.addEventListener('change', () => {
    if (!agreement.disabled) saveAcceptance(agreement.checked);
  });
  function closePolicies() {
    dialog.close();
    document.body.style.overflow = reviewing ? previousBodyOverflow : '';
    document.documentElement.style.overflow = previousRootOverflow;
    if (reviewing) {
      reviewTrigger?.focus({ preventScroll: true });
    } else {
      document.getElementById('courts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('courtSharedDateDisplay')?.focus({ preventScroll: true });
    }
  }
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (reviewing) closePolicies();
  });
  dialog.querySelector('.court-policies-agree').addEventListener('click', () => {
    if (!reviewing || !accepted) {
      saveAcceptance(true);
      syncPaymentAgreement();
    }
    closePolicies();
  });
  function showPolicies(isReview, trigger) {
    if (dialog.open) return true;
    if (!isReview && accepted) { syncPaymentAgreement(); return false; }
    reviewing = isReview;
    reviewTrigger = trigger || null;
    previousRootOverflow = document.documentElement.style.overflow;
    previousBodyOverflow = document.body.style.overflow;
    dialog.querySelector('.court-policies-agree').textContent = reviewing && accepted ? 'Close' : 'Agree & Continue';
    dialog.showModal();
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    dialog.querySelector('.court-policies-poster').focus({ preventScroll: true });
    return true;
  }
  window.ChinoCourtPolicies = {
    open() { return showPolicies(false); },
    review(trigger) { return showPolicies(true, trigger); },
    syncPaymentAgreement,
    isOpen() { return dialog.open; },
  };
  syncPaymentAgreement();
})();
