// Stop native image/link drag ghosts without suppressing scrolling, text editing,
// QR opening, downloads, or application controls that implement their own drag.
document.addEventListener('dragstart', event => {
  const target = event.target;
  if (target instanceof Element && target.closest('img, a') &&
      !target.closest('[draggable="true"], input, textarea, [contenteditable="true"]')) {
    event.preventDefault();
  }
});
