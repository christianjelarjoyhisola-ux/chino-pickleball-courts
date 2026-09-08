// Stop native image/link drag ghosts without suppressing scrolling, text editing,
// QR opening, downloads, or application controls that implement their own drag.
document.addEventListener('dragstart', event => {
  const target = event.target;
  if (target instanceof Element && target.closest('img, a') &&
      !target.closest('[draggable="true"], input, textarea, [contenteditable="true"]')) {
    event.preventDefault();
  }
});

// One gentle cue after players reach the court list; never cover checkout.
(() => {
  const grid = document.getElementById('courtsGrid');
  if (!grid) return;
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'court-scroll-hint';
  hint.hidden = true;
  hint.innerHTML = '<span>Scroll down to see more courts</span><span class="court-scroll-arrow" aria-hidden="true">↓</span>';
  document.body.appendChild(hint);
  let timer = 0;
  let done = false;
  let shownAt = 0;
  function nextCourt() {
    const cards = [...grid.querySelectorAll(':scope > .cc')];
    return cards.length > 1 ? cards.slice(1).find(card => card.getBoundingClientRect().top >= window.innerHeight - 40) : null;
  }
  function eligible() {
    const splash = document.getElementById('splashScreen');
    const rect = grid.getBoundingClientRect();
    return !document.hidden && (!splash || splash.classList.contains('dismissed')) &&
      getComputedStyle(document.body).overflow !== 'hidden' &&
      rect.top < innerHeight && rect.bottom > 0 && !!nextCourt();
  }
  function dismiss() {
    done = true;
    hint.hidden = true;
    clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', update);
  }
  function update() {
    if (done) return;
    if (!eligible()) { clearTimeout(timer); timer = 0; hint.hidden = true; return; }
    if (!hint.hidden || timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      if (done || !eligible()) return;
      shownAt = window.scrollY;
      hint.hidden = false;
    }, 2500);
  }
  function onScroll() {
    if (!hint.hidden && Math.abs(window.scrollY - shownAt) > 24) dismiss();
    else update();
  }
  hint.addEventListener('click', () => {
    const target = nextCourt();
    dismiss();
    target?.scrollIntoView({block:'start', behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  });
  grid.addEventListener('click', event => { if (event.target.closest('.cc-slot-btn, button')) dismiss(); });
  const observer = new MutationObserver(update);
  observer.observe(grid, {childList:true});
  observer.observe(document.body, {attributes:true, attributeFilter:['style','class']});
  const splash = document.getElementById('splashScreen');
  if (splash) observer.observe(splash, {attributes:true, attributeFilter:['class','style']});
  window.addEventListener('scroll', onScroll, {passive:true});
  window.addEventListener('resize', update);
  document.addEventListener('visibilitychange', update);
  update();
})();
