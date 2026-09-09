const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync('court-policies.js', 'utf8');
const storageKey = 'chino-court-policies:2026-09-09';

function createHarness({ accepted = false, storageUnavailable = false } = {}) {
  const storage = new Map(accepted ? [[storageKey, 'accepted']] : []);
  const focusCalls = [];
  const scrollCalls = [];
  let document;

  function element(id) {
    const listeners = new Map();
    return {
      id,
      style: {},
      checked: false,
      disabled: false,
      open: false,
      textContent: '',
      isConnected: true,
      setAttribute() {},
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      dispatchEvent(event) {
        event.target = this;
        for (const listener of listeners.get(event.type) || []) listener(event);
        return !event.defaultPrevented;
      },
      focus(options) {
        document.activeElement = this;
        focusCalls.push({ id, options });
      },
      scrollIntoView(options) { scrollCalls.push({ id, options }); },
      showModal() { this.open = true; },
      close() {
        this.open = false;
        this.dispatchEvent({ type: 'close' });
      },
      closest() { return null; },
    };
  }

  const nodes = {
    courtPoliciesAgree: element('courtPoliciesAgree'),
    courts: element('courts'),
    courtSharedDateDisplay: element('courtSharedDateDisplay'),
  };
  const trigger = element('review-trigger');
  const poster = element('poster');
  const button = element('agree-button');
  const dialog = element('dialog');
  dialog.querySelector = selector => ({
    '.court-policies-poster': poster,
    '.court-policies-agree': button,
  }[selector] || null);
  document = {
    activeElement: trigger,
    body: { style: { overflow: 'auto' }, append() {} },
    documentElement: { style: { overflow: 'scroll' } },
    createElement(tag) {
      assert.equal(tag, 'dialog');
      return dialog;
    },
    getElementById: id => nodes[id] || null,
    contains: node => !!node?.isConnected,
  };
  const sessionStorage = {
    getItem(key) {
      if (storageUnavailable) throw new Error('Storage is unavailable');
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (storageUnavailable) throw new Error('Storage is unavailable');
      storage.set(key, String(value));
    },
    removeItem(key) {
      if (storageUnavailable) throw new Error('Storage is unavailable');
      storage.delete(key);
    },
  };
  const context = vm.createContext({
    document,
    window: {},
    sessionStorage,
    Event: class Event {
      constructor(type) { this.type = type; this.defaultPrevented = false; }
      preventDefault() { this.defaultPrevented = true; }
    },
  });
  vm.runInContext(script, context, { filename: 'court-policies.js' });
  return {
    api: context.window.ChinoCourtPolicies,
    button,
    dialog,
    document,
    nodes,
    storage,
    trigger,
    focusCalls,
    scrollCalls,
    clickAgree() { button.dispatchEvent({ type: 'click' }); },
    changeAgreement(checked) {
      nodes.courtPoliciesAgree.checked = checked;
      nodes.courtPoliciesAgree.dispatchEvent({ type: 'change' });
    },
  };
}

test('Agree & Continue remembers the court rules and checks the payment policy agreement', () => {
  const harness = createHarness();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, false);
  assert.equal(harness.api.open(), true);
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.document.body.style.overflow, 'hidden');
  assert.equal(harness.document.documentElement.style.overflow, 'hidden');

  harness.clickAgree();

  assert.equal(harness.dialog.open, false);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
  assert.equal(harness.storage.get(storageKey), 'accepted');
  assert.equal(harness.api.open(), false, 'accepted court rules do not interrupt entry again');
  assert.equal(harness.scrollCalls.length, 1);
  assert.equal(harness.scrollCalls[0].id, 'courts');
});

test('a remembered court agreement initializes the payment checkbox', () => {
  const harness = createHarness({ accepted: true });
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
  assert.equal(harness.api.open(), false);
});

test('sync restores court agreement after booking form reset', () => {
  const harness = createHarness({ accepted: true });
  harness.nodes.courtPoliciesAgree.checked = false;
  harness.api.syncPaymentAgreement();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
});

test('unchecking court policies revokes the remembered agreement and makes entry require agreement again', () => {
  const harness = createHarness({ accepted: true });
  harness.changeAgreement(false);
  assert.notEqual(harness.storage.get(storageKey), 'accepted');
  harness.api.syncPaymentAgreement();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, false);
  assert.equal(harness.api.open(), true);
  harness.clickAgree();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
  assert.equal(harness.storage.get(storageKey), 'accepted');
});

test('manually checking the court policy checkbox remembers that agreement', () => {
  const harness = createHarness();
  harness.changeAgreement(true);
  assert.equal(harness.storage.get(storageKey), 'accepted');
  assert.equal(harness.api.open(), false);
});

test('the Court Policies link reopens accepted policies and returns to the payment form without court navigation', () => {
  const harness = createHarness({ accepted: true });
  harness.api.review(harness.trigger);
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.button.textContent, 'Close');
  assert.equal(harness.document.body.style.overflow, 'hidden');
  harness.clickAgree();
  assert.equal(harness.dialog.open, false);
  assert.equal(harness.document.body.style.overflow, 'auto');
  assert.equal(harness.document.documentElement.style.overflow, 'scroll');
  assert.equal(harness.document.activeElement, harness.trigger);
  assert.equal(harness.scrollCalls.length, 0);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
});

test('reviewing unaccepted policies lets a customer agree and returns to the payment form', () => {
  const harness = createHarness();
  harness.api.review(harness.trigger);
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.button.textContent, 'Agree & Continue');
  harness.clickAgree();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
  assert.equal(harness.document.activeElement, harness.trigger);
  assert.equal(harness.scrollCalls.length, 0);
});

test('court agreement still works within the page when session storage is unavailable', () => {
  const harness = createHarness({ storageUnavailable: true });
  harness.api.open();
  assert.doesNotThrow(() => harness.clickAgree());
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
  assert.equal(harness.api.open(), false);
  assert.doesNotThrow(() => harness.changeAgreement(false));
  assert.equal(harness.api.open(), true);
});
