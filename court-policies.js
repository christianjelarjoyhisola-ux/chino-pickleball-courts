(() => {
  'use strict';
  const storageKey = 'chino-court-policies:2026-09-09';
  let accepted = false;
  let previousRootOverflow = '';
  let previousBodyOverflow = '';
  let reviewTrigger = null;
  let reviewing = false;
  let textLoaded = false;
  let textLoading = null;
  try { accepted = sessionStorage.getItem(storageKey) === 'accepted'; } catch (_) {}
  const dialog = document.createElement('dialog');
  dialog.className = 'court-policies-dialog';
  dialog.setAttribute('aria-labelledby', 'courtPoliciesTitle');
  dialog.setAttribute('aria-describedby', 'courtPoliciesIntro');
  dialog.innerHTML = `
    <h2 class="court-policies-sr-only" id="courtPoliciesTitle">Court policies</h2>
    <p class="court-policies-sr-only" id="courtPoliciesIntro">Review the poster or text version. Selecting Agree &amp; Continue means you agree to these court policies.</p>
    <header class="court-policies-review-heading" hidden><span>CHINO Pickleball Courts</span><h3 tabindex="-1">Court policies</h3><p id="courtPoliciesTextIntro">For a safe, enjoyable, and respectful playing environment.</p></header>
    <div class="court-policies-content">
      <a class="court-policies-poster" href="assets/court-policies.png" target="_blank" rel="noopener" aria-label="Enlarge court policies poster (opens in a new tab)">
        <img src="assets/court-policies.png" width="1024" height="1536" alt="CHINO court policies poster. Tap to enlarge, or use the text version below.">
      </a>
    </div>
    <div class="court-policies-text" tabindex="0" role="region" aria-label="Court policies text" hidden></div>
    <footer class="court-policies-actions">
      <div class="court-policies-help">Tap to enlarge · <a href="court-policies.html" target="_blank" rel="noopener" aria-label="Read court policies as text (opens in a new tab)">Read as text ↗</a></div>
      <div class="court-policies-buttons">
        <button type="button" class="court-policies-agree">Agree &amp; Continue</button>
      </div>
    </footer>`;
  document.body.append(dialog);
  const textView = dialog.querySelector('.court-policies-text');
  const reviewHeading = dialog.querySelector('.court-policies-review-heading');
  const agreeButton = dialog.querySelector('.court-policies-agree');
  function loadPolicyText() {
    if (textLoaded) return Promise.resolve();
    if (textLoading) return textLoading;
    textView.innerHTML = '<p class="court-policies-load" role="status">Loading court policies…</p>';
    if (reviewing && !accepted) agreeButton.disabled = true;
    textLoading = Promise.resolve().then(async () => {
      try {
        const response = await fetch('court-policies.html?v=20260909-policy-text-v1');
        if (!response.ok) throw new Error('Policy text unavailable');
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const content = page.getElementById('courtPoliciesText');
        if (!content || !content.querySelector('ol')) throw new Error('Policy text missing');
        textView.innerHTML = content.innerHTML;
        textLoaded = true;
        if (reviewing) agreeButton.disabled = false;
      } catch (_) {
        textView.innerHTML = '<div class="court-policies-load" role="status"><p>We couldn’t load the policies. Please try again.</p><button type="button" class="court-policies-retry">Try again</button><a href="court-policies.html" target="_blank" rel="noopener">Open text in a new tab ↗</a></div>';
      } finally { textLoading = null; }
    });
    return textLoading;
  }
  textView.addEventListener('click', event => {
    if (event.target.closest('.court-policies-retry')) void loadPolicyText();
  });
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
  agreeButton.addEventListener('click', () => {
    if (agreeButton.disabled) return;
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
    dialog.dataset.view = reviewing ? 'text' : 'poster';
    dialog.setAttribute('aria-describedby', reviewing ? 'courtPoliciesTextIntro' : 'courtPoliciesIntro');
    reviewHeading.hidden = !reviewing;
    textView.hidden = !reviewing;
    dialog.querySelector('.court-policies-content').hidden = reviewing;
    dialog.querySelector('.court-policies-help').hidden = reviewing;
    agreeButton.textContent = reviewing && accepted ? 'Close' : 'Agree & Continue';
    agreeButton.disabled = reviewing && !accepted && !textLoaded;
    dialog.showModal();
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    if (reviewing) {
      textView.scrollTop = 0;
      reviewHeading.querySelector('h3').focus({ preventScroll: true });
      void loadPolicyText();
    } else dialog.querySelector('.court-policies-poster').focus({ preventScroll: true });
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
