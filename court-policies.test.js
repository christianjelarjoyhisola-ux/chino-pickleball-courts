const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync('court-policies.js', 'utf8');
const storageKey = 'chino-court-policies:payment:2026-09-09-v2';
const legacyKey = 'chino-court-policies:2026-09-09';
const booking = 'PB-CURRENT-BOOKING';
const policyMarkup = '<section><h3>Booking &amp; payment</h3><ol><li>Full payment is required.</li></ol></section>';
const policyPage = `<main id="courtPoliciesText">${policyMarkup}</main>`;
const settle = () => new Promise(resolve => setImmediate(resolve));

function createHarness({ stored = [], storageUnavailable = false, responses = [], context = booking, disabled = false } = {}) {
  const storage = new Map(stored);
  const focusCalls = [];
  const fetchCalls = [];
  const agreementChanges = [];
  let document;
  function element(id) {
    const listeners = new Map();
    return {
      id, style: {}, dataset: {}, checked: false, disabled: false, open: false,
      textContent: '', isConnected: true,
      setAttribute() {},
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      dispatchEvent(event) {
        event.target ||= this;
        for (const listener of listeners.get(event.type) || []) listener(event);
        return !event.defaultPrevented;
      },
      focus(options) { document.activeElement = this; focusCalls.push({ id, options }); },
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatchEvent({ type: 'close' }); },
      closest() { return null; },
    };
  }
  const agreement = element('courtPoliciesAgree');
  agreement.disabled = disabled;
  agreement.addEventListener('change', () => agreementChanges.push(agreement.checked));
  const trigger = element('start-payment');
  const button = element('agree-button');
  const closeButton = element('close-button');
  const dialog = element('dialog');
  const textView = element('policy-text');
  const title = element('policy-title');
  dialog.querySelector = selector => ({
    '.court-policies-agree': button,
    '.court-policies-close': closeButton,
    '.court-policies-text': textView,
    '#courtPoliciesTitle': title,
  }[selector] || null);
  document = {
    activeElement: trigger,
    body: { style: { overflow: 'auto' }, append() {} },
    documentElement: { style: { overflow: 'scroll' } },
    createElement(tag) { assert.equal(tag, 'dialog'); return dialog; },
    getElementById: id => id === agreement.id ? agreement : null,
  };
  const sessionStorage = {
    getItem(key) { if (storageUnavailable) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageUnavailable) throw new Error('Storage unavailable'); storage.set(key, String(value)); },
    removeItem(key) { if (storageUnavailable) throw new Error('Storage unavailable'); storage.delete(key); },
  };
  const sandbox = vm.createContext({
    document, window: {}, sessionStorage,
    async fetch(url) {
      fetchCalls.push(url);
      const response = await (responses.length ? responses.shift() : {});
      if (response instanceof Error) throw response;
      return { ok: response.ok ?? true, text: async () => response.html ?? policyPage };
    },
    DOMParser: class DOMParser {
      parseFromString(html, type) {
        assert.equal(type, 'text/html');
        const match = html.match(/<main id="courtPoliciesText">([\s\S]*?)<\/main>/);
        return { getElementById(id) {
          if (id !== 'courtPoliciesText' || !match) return null;
          return { innerHTML: match[1], querySelector: selector => selector === 'ol' && /<ol\b/.test(match[1]) ? {} : null };
        } };
      }
    },
    Event: class Event {
      constructor(type) { this.type = type; this.defaultPrevented = false; }
      preventDefault() { this.defaultPrevented = true; }
    },
  });
  vm.runInContext(script, sandbox, { filename: 'court-policies.js' });
  const api = sandbox.window.ChinoCourtPolicies;
  if (context !== null) api.setBookingContext(context);
  return {
    api, agreement, button, closeButton, dialog, document, storage, trigger,
    focusCalls, fetchCalls, agreementChanges, textView,
    clickAgree() { button.dispatchEvent({ type: 'click' }); },
    clickClose() { closeButton.dispatchEvent({ type: 'click' }); },
    pressEscape() {
      const event = { type: 'cancel', preventDefault() { this.defaultPrevented = true; } };
      dialog.dispatchEvent(event); return event;
    },
    retry() {
      const target = { closest: selector => selector === '.court-policies-retry' ? target : null };
      textView.dispatchEvent({ type: 'click', target });
    },
    changeAgreement(checked) {
      agreement.checked = checked;
      agreement.dispatchEvent({ type: 'change' });
    },
  };
}
const remembered = ref => [[storageKey, JSON.stringify({ bookingRef: ref, accepted: true })]];

async function accept(harness) {
  const decision = harness.api.requestAgreement(harness.trigger);
  await settle();
  harness.clickAgree();
  assert.equal(await decision, true);
}

test('text-only policies load before explicit agreement checks the payment checkbox', async () => {
  const h = createHarness();
  assert.equal(h.dialog.open, false, 'there is no automatic welcome interruption');
  assert.doesNotMatch(h.dialog.innerHTML, /<img|court-policies-poster|Tap to enlarge/);
  const result = h.api.requestAgreement(h.trigger);
  assert.equal(h.dialog.open, true);
  assert.equal(h.document.body.style.overflow, 'hidden');
  assert.equal(h.document.documentElement.style.overflow, 'hidden');
  assert.equal(h.document.activeElement.id, 'policy-title');
  assert.equal(h.button.disabled, true);
  h.clickAgree();
  assert.equal(h.agreement.checked, false);
  await settle();
  assert.equal(h.textView.innerHTML, policyMarkup);
  assert.equal(h.button.disabled, false);
  h.clickAgree();
  assert.equal(await result, true);
  assert.equal(h.dialog.open, false);
  assert.equal(h.agreement.checked, true);
  assert.deepEqual(h.agreementChanges, [true], 'acceptance notifies existing payment gating once');
  assert.deepEqual(JSON.parse(h.storage.get(storageKey)), { bookingRef: booking, accepted: true });
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.equal(h.document.documentElement.style.overflow, 'scroll');
  assert.equal(h.document.activeElement, h.trigger);
});

test('same booking keeps acceptance and reload restores only its matching reservation', async () => {
  const h = createHarness();
  await accept(h);
  h.agreement.checked = false;
  h.api.setBookingContext(booking);
  assert.equal(h.agreement.checked, true);
  assert.equal(await h.api.requestAgreement(h.trigger), true);
  assert.equal(h.dialog.open, false);
  const reload = createHarness({ stored: [...h.storage] });
  assert.equal(reload.agreement.checked, true);
  assert.equal(await reload.api.requestAgreement(reload.trigger), true);
  assert.equal(reload.fetchCalls.length, 0);
});

test('new reservation never inherits another reservation or old poster consent', async () => {
  for (const stored of [remembered('PB-OTHER'), [[legacyKey, 'accepted']]]) {
    const h = createHarness({ stored });
    assert.equal(h.agreement.checked, false);
    const result = h.api.requestAgreement(h.trigger);
    await settle();
    assert.equal(h.dialog.open, true);
    h.api.dismiss();
    assert.equal(await result, false);
  }
  const h = createHarness();
  await accept(h);
  h.api.setBookingContext('PB-NEXT');
  assert.equal(h.agreement.checked, false);
  assert.equal(h.storage.has(storageKey), false);
});

test('unknown context cannot restore or create acceptance but can read policies', async () => {
  for (const context of [null, '', undefined, 123]) {
    const h = createHarness({ context: null, stored: remembered(booking) });
    if (context !== null) h.api.setBookingContext(context);
    assert.equal(h.agreement.checked, false);
    assert.equal(await h.api.requestAgreement(h.trigger), false);
    assert.equal(h.dialog.open, false);
    h.api.review(h.trigger);
    await settle();
    assert.equal(h.button.textContent, 'Close');
    h.clickAgree();
    assert.equal(h.agreement.checked, false);
  }
});

test('corrupt stored consent is ignored', () => {
  const h = createHarness({ stored: [[storageKey, '{invalid json']] });
  assert.equal(h.agreement.checked, false);
});

test('unchecking revokes agreement; manually checking opens review without bypassing consent', async () => {
  const h = createHarness({ stored: remembered(booking) });
  h.changeAgreement(false);
  assert.equal(h.storage.has(storageKey), false);
  h.changeAgreement(true);
  assert.equal(h.agreement.checked, false);
  assert.equal(h.agreementChanges.at(-1), false, 'payment gating is refreshed after intercepted check');
  assert.equal(h.dialog.open, true);
  await settle();
  h.clickAgree();
  assert.equal(h.agreement.checked, true);
  assert.equal(h.agreementChanges.at(-1), true);
});

test('concurrent Start Payment requests share one dialog and one decision', async () => {
  const h = createHarness();
  const first = h.api.requestAgreement(h.trigger);
  const second = h.api.requestAgreement(h.trigger);
  assert.equal(first, second);
  await settle();
  assert.equal(h.fetchCalls.length, 1);
  h.clickAgree();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(h.agreementChanges, [true]);
});

test('Escape, close button, external dialog close and dismiss all resolve cancellation', async () => {
  for (const close of [h => h.pressEscape(), h => h.clickClose(), h => h.dialog.close(), h => h.api.dismiss()]) {
    const h = createHarness();
    const first = h.api.requestAgreement(h.trigger);
    const second = h.api.requestAgreement(h.trigger);
    await settle();
    close(h);
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(h.agreement.checked, false);
    assert.equal(h.storage.has(storageKey), false);
    assert.equal(h.dialog.open, false);
    assert.equal(h.document.body.style.overflow, 'auto');
    assert.equal(h.document.documentElement.style.overflow, 'scroll');
    assert.equal(h.document.activeElement, h.trigger);
  }
});

test('Court Policies link reopens agreed text with Close, preserving acceptance', async () => {
  const h = createHarness({ stored: remembered(booking) });
  assert.equal(h.api.review(h.trigger), true);
  assert.equal(h.button.textContent, 'Close');
  await settle();
  h.textView.scrollTop = 500;
  h.clickAgree();
  assert.equal(h.agreement.checked, true);
  h.api.review(h.trigger);
  assert.equal(h.textView.scrollTop, 0);
  assert.equal(h.button.textContent, 'Close');
  await settle();
  assert.equal(h.fetchCalls.length, 1);
  assert.deepEqual(h.fetchCalls, ['court-policies.html?v=20260909-payment-policies-v2']);
  h.pressEscape();
  assert.equal(h.agreement.checked, true);
});

test('request during an unaccepted link review uses the existing dialog', async () => {
  const h = createHarness();
  h.api.review(h.trigger);
  const result = h.api.requestAgreement(h.trigger);
  await settle();
  assert.equal(h.fetchCalls.length, 1);
  h.clickAgree();
  assert.equal(await result, true);
});

test('failed loading requires a successful retry before payment consent', async () => {
  const h = createHarness({ responses: [{ ok: false }, {}] });
  const result = h.api.requestAgreement(h.trigger);
  await settle();
  assert.match(h.textView.innerHTML, /Try again/);
  assert.equal(h.button.disabled, true);
  h.clickAgree();
  assert.equal(h.agreement.checked, false);
  h.retry();
  await settle();
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.button.disabled, false);
  h.clickAgree();
  assert.equal(await result, true);
});

test('incomplete policy content and network errors cannot enable agreement', async () => {
  for (const response of [new Error('Offline'), { html: '<main>Unrelated page</main>' }, { html: '<main id="courtPoliciesText"><p>Incomplete</p></main>' }]) {
    const h = createHarness({ responses: [response] });
    const result = h.api.requestAgreement(h.trigger);
    await settle();
    assert.match(h.textView.innerHTML, /Try again/);
    assert.equal(h.button.disabled, true);
    h.clickAgree();
    assert.equal(h.agreement.checked, false);
    h.clickClose();
    assert.equal(await result, false);
  }
});

test('late fetch after cancellation cannot reopen or accept, but text can be reused', async () => {
  let complete;
  const h = createHarness({ responses: [new Promise(resolve => { complete = resolve; })] });
  const result = h.api.requestAgreement(h.trigger);
  await settle();
  h.api.dismiss();
  assert.equal(await result, false);
  complete({});
  await settle();
  assert.equal(h.dialog.open, false);
  assert.equal(h.agreement.checked, false);
  assert.equal(h.storage.has(storageKey), false);
  assert.equal(h.document.body.style.overflow, 'auto');
  await accept(h);
  assert.equal(h.fetchCalls.length, 1);
});

test('switching booking while policies load cancels old payment and requires new consent', async () => {
  let complete;
  const h = createHarness({ responses: [new Promise(resolve => { complete = resolve; })] });
  const oldResult = h.api.requestAgreement(h.trigger);
  await settle();
  h.api.setBookingContext('PB-NEW');
  assert.equal(await oldResult, false);
  const newResult = h.api.requestAgreement(h.trigger);
  complete({});
  await settle();
  assert.equal(h.agreement.checked, false);
  h.clickAgree();
  assert.equal(await newResult, true);
  assert.equal(JSON.parse(h.storage.get(storageKey)).bookingRef, 'PB-NEW');
});

test('reset cancels pending request and clears booking consent without unlocking a locked checkbox', async () => {
  const h = createHarness();
  const result = h.api.requestAgreement(h.trigger);
  h.api.resetAgreement();
  assert.equal(await result, false);
  assert.equal(await h.api.requestAgreement(h.trigger), false);
  h.api.setBookingContext(booking);
  await accept(h);
  h.agreement.disabled = true;
  h.api.resetAgreement();
  assert.equal(h.agreement.disabled, true);
  assert.equal(h.agreement.checked, true, 'locked payment state is left untouched');
  assert.equal(h.storage.has(storageKey), false);
  h.agreement.disabled = false;
  h.api.syncPaymentAgreement();
  assert.equal(h.agreement.checked, false);
});

test('locked payments cannot gain new consent through request or a previously opened review', async () => {
  const locked = createHarness({ disabled: true });
  assert.equal(await locked.api.requestAgreement(locked.trigger), false);
  locked.api.review(locked.trigger);
  await settle();
  assert.equal(locked.button.textContent, 'Close');
  locked.clickAgree();
  assert.equal(locked.agreement.checked, false);
  const h = createHarness();
  const result = h.api.requestAgreement(h.trigger);
  await settle();
  h.agreement.disabled = true;
  h.clickAgree();
  assert.equal(await result, false);
  assert.equal(h.agreement.checked, false);
  assert.equal(h.storage.has(storageKey), false);
});

test('accepted text review can close after a load failure without revoking consent', async () => {
  const h = createHarness({ stored: remembered(booking), responses: [{ ok: false }] });
  h.api.review(h.trigger);
  await settle();
  assert.equal(h.button.textContent, 'Close');
  assert.equal(h.button.disabled, false);
  h.clickAgree();
  assert.equal(h.agreement.checked, true);
});

test('storage failure still permits explicit consent for the current page only', async () => {
  const h = createHarness({ storageUnavailable: true });
  await accept(h);
  assert.equal(h.agreement.checked, true);
  assert.equal(await h.api.requestAgreement(h.trigger), true);
  h.api.setBookingContext('PB-NEXT');
  assert.equal(h.agreement.checked, false);
});

test('a dialog display failure safely cancels without changing page scroll', async () => {
  const h = createHarness();
  h.dialog.showModal = () => { throw new Error('Dialog unavailable'); };
  assert.equal(await h.api.requestAgreement(h.trigger), false);
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.equal(h.agreement.checked, false);
});
