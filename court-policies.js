(() => {
  'use strict';
  const storageKey = 'chino-court-policies:2026-09-09';
  let accepted = false;
  let previousRootOverflow = ''; 
  try { accepted = sessionStorage.getItem(storageKey) === 'accepted'; } catch (_) {}
  const dialog = document.createElement('dialog');
  dialog.className = 'court-policies-dialog';
  dialog.setAttribute('aria-labelledby', 'courtPoliciesTitle');
  dialog.setAttribute('aria-describedby', 'courtPoliciesIntro');
  dialog.innerHTML = `
    <header class="court-policies-heading">
      <h2 id="courtPoliciesTitle" tabindex="-1">Before you book</h2>
      <p id="courtPoliciesIntro">Please review our court policies for a safe and enjoyable game.</p>
    </header>
    <div class="court-policies-content">
      <a class="court-policies-poster" href="assets/court-policies.png" target="_blank" rel="noopener" aria-label="Enlarge court policies poster (opens in a new tab)">
        <img src="assets/court-policies.png" width="1024" height="1536" alt="CHINO court policies poster. Tap to enlarge, or use the text version below.">
      </a>
    </div>
    <footer class="court-policies-actions">
      <div class="court-policies-help">Tap the poster to enlarge · <a href="court-policies.html" target="_blank" rel="noopener">Read as text (new tab)</a></div>
      <p>By selecting Agree &amp; Continue, you acknowledge and agree to these court policies.</p>
      <div class="court-policies-buttons">
        <button type="button" class="court-policies-agree">Agree &amp; Continue</button>
      </div>
    </footer>`;
  document.body.append(dialog);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); });
  dialog.querySelector('.court-policies-agree').addEventListener('click', () => {
    accepted = true;
    try { sessionStorage.setItem(storageKey, 'accepted'); } catch (_) {}
    dialog.close();
    document.body.style.overflow = '';
    document.documentElement.style.overflow = previousRootOverflow;
    document.getElementById('courts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('courtSharedDateDisplay')?.focus({ preventScroll: true });
  });
  window.ChinoCourtPolicies = {
    open() {
      if (accepted) return false;
      if (!dialog.open) {
        previousRootOverflow = document.documentElement.style.overflow;
        dialog.showModal();
      }
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      dialog.querySelector('#courtPoliciesTitle').focus();
      return true;
    },
    isOpen() { return dialog.open; },
  };
})();
