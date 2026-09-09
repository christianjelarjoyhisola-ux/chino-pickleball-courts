const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync('court-policies.js', 'utf8');
const storageKey = 'chino-court-policies:2026-09-09';
const policyMarkup = '<section><h4>Booking &amp; payment</h4><ol><li>Full payment is required.</li></ol></section>';
const policyPage = `<main id="courtPoliciesText">${policyMarkup}</main>`;
const settle = () => new Promise(resolve => setImmediate(resolve));

function createHarness({ accepted = false, storageUnavailable = false, responses = [] } = {}) {
  const storage = new Map(accepted ? [[storageKey, 'accepted']] : []);
  const focusCalls = [];
  const scrollCalls = [];
  const fetchCalls = [];
  let document;

  function element(id) {
    const listeners = new Map();
    return {
      id,
      style: {},
      dataset: {},
      hidden: false,
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
        event.target ||= this;
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
  const textView = element('policy-text');
  const heading = element('review-heading');
  const headingTitle = element('review-title');
  const content = element('poster-content');
  const help = element('poster-help');
  heading.querySelector = selector => selector === 'h3' ? headingTitle : null;
  dialog.querySelector = selector => ({
    '.court-policies-poster': poster,
    '.court-policies-agree': button,
    '.court-policies-text': textView,
    '.court-policies-review-heading': heading,
    '.court-policies-content': content,
    '.court-policies-help': help,
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
        return {
          getElementById(id) {
            if (id !== 'courtPoliciesText' || !match) return null;
            return {
              innerHTML: match[1],
              querySelector: selector => selector === 'ol' && /<ol\b/.test(match[1]) ? {} : null,
            };
          },
        };
      }
    },
    Event: class Event {
      constructor(type) { this.type = type; this.defaultPrevented = false; }
      preventDefault() { this.defaultPrevented = true; }
    },
  });
  vm.runInContext(script, context, { filename: 'court-policies.js' });
  return {
    api: context.window.ChinoCourtPolicies,
    button,
    content,
    dialog,
    document,
    nodes,
    storage,
    trigger,
    focusCalls,
    scrollCalls,
    fetchCalls,
    heading,
    help,
    poster,
    textView,
    clickAgree() { button.dispatchEvent({ type: 'click' }); },
    pressEscape() {
      const event = { type: 'cancel', preventDefault() { this.defaultPrevented = true; } };
      dialog.dispatchEvent(event);
      return event;
    },
    retry() {
      const target = { closest: selector => selector === '.court-policies-retry' ? target : null };
      textView.dispatchEvent({ type: 'click', target });
    },
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
  assert.equal(harness.dialog.dataset.view, 'poster');
  assert.equal(harness.content.hidden, false);
  assert.equal(harness.textView.hidden, true);
  assert.equal(harness.heading.hidden, true);
  assert.equal(harness.help.hidden, false);
  assert.equal(harness.document.activeElement, harness.poster);
  assert.equal(harness.fetchCalls.length, 0, 'entry poster does not load the text page');

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

test('the Court Policies link opens accepted policies as text and returns to the payment form without court navigation', async () => {
  const harness = createHarness({ accepted: true });
  harness.api.review(harness.trigger);
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.button.textContent, 'Close');
  assert.equal(harness.document.body.style.overflow, 'hidden');
  assert.equal(harness.dialog.dataset.view, 'text');
  assert.equal(harness.content.hidden, true);
  assert.equal(harness.textView.hidden, false);
  assert.equal(harness.heading.hidden, false);
  assert.equal(harness.help.hidden, true);
  assert.equal(harness.document.activeElement.id, 'review-title');
  await settle();
  assert.equal(harness.textView.innerHTML, policyMarkup);
  assert.deepEqual(harness.fetchCalls, ['court-policies.html?v=20260909-policy-text-v1']);
  harness.clickAgree();
  assert.equal(harness.dialog.open, false);
  assert.equal(harness.document.body.style.overflow, 'auto');
  assert.equal(harness.document.documentElement.style.overflow, 'scroll');
  assert.equal(harness.document.activeElement, harness.trigger);
  assert.equal(harness.scrollCalls.length, 0);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
});

test('reviewing unaccepted policies lets a customer agree after text loads and returns to the payment form', async () => {
  const harness = createHarness();
  harness.api.review(harness.trigger);
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.button.textContent, 'Agree & Continue');
  assert.equal(harness.button.disabled, true);
  harness.clickAgree();
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, false);
  await settle();
  assert.equal(harness.button.disabled, false);
  harness.clickAgree();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
  assert.equal(harness.document.activeElement, harness.trigger);
  assert.equal(harness.scrollCalls.length, 0);
});

test('policy text is loaded once per page and starts at the top on each review', async () => {
  const harness = createHarness({ accepted: true });
  harness.api.review(harness.trigger);
  await settle();
  harness.textView.scrollTop = 500;
  harness.clickAgree();
  harness.api.review(harness.trigger);
  await settle();
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.textView.scrollTop, 0);
  assert.equal(harness.textView.innerHTML, policyMarkup);
  assert.equal(harness.button.disabled, false);
});

test('Escape closes a policy review without changing acceptance and restores focus and scroll', async () => {
  for (const accepted of [false, true]) {
    const harness = createHarness({ accepted });
    harness.api.review(harness.trigger);
    await settle();
    const event = harness.pressEscape();
    assert.equal(event.defaultPrevented, true);
    assert.equal(harness.dialog.open, false);
    assert.equal(harness.nodes.courtPoliciesAgree.checked, accepted);
    assert.equal(harness.storage.get(storageKey) === 'accepted', accepted);
    assert.equal(harness.document.activeElement, harness.trigger);
    assert.equal(harness.document.body.style.overflow, 'auto');
    assert.equal(harness.document.documentElement.style.overflow, 'scroll');
    assert.equal(harness.scrollCalls.length, 0);
  }
});

test('returning from unaccepted text review to entry restores the required poster', async () => {
  const harness = createHarness();
  harness.api.review(harness.trigger);
  await settle();
  harness.pressEscape();
  harness.api.open();
  assert.equal(harness.dialog.dataset.view, 'poster');
  assert.equal(harness.content.hidden, false);
  assert.equal(harness.textView.hidden, true);
  assert.equal(harness.heading.hidden, true);
  assert.equal(harness.help.hidden, false);
  assert.equal(harness.button.disabled, false);
  harness.pressEscape();
  assert.equal(harness.dialog.open, true, 'entry still requires explicit agreement');
  assert.equal(harness.nodes.courtPoliciesAgree.checked, false);
  harness.clickAgree();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
});

test('a pending text request cannot grant agreement and is shared when review is reopened', async () => {
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const harness = createHarness({ responses: [response] });
  harness.api.review(harness.trigger);
  await settle();
  assert.equal(harness.fetchCalls.length, 1);
  assert.match(harness.textView.innerHTML, /Loading court policies/);
  harness.clickAgree();
  assert.equal(harness.nodes.courtPoliciesAgree.checked, false);
  harness.pressEscape();
  harness.api.review(harness.trigger);
  await settle();
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.button.disabled, true);
  resolveResponse({});
  await settle();
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, false, 'loading text alone never accepts policies');
});

test('a failed text request requires a successful retry before unaccepted policies can be agreed', async () => {
  const harness = createHarness({ responses: [{ ok: false }, {}] });
  harness.api.review(harness.trigger);
  await settle();
  assert.match(harness.textView.innerHTML, /Try again/);
  assert.equal(harness.button.disabled, true);
  harness.clickAgree();
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, false);
  harness.retry();
  assert.equal(harness.button.disabled, true);
  await settle();
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.textView.innerHTML, policyMarkup);
  assert.equal(harness.button.disabled, false);
  harness.clickAgree();
  assert.equal(harness.dialog.open, false);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
});

test('missing or malformed policy content cannot enable acceptance', async () => {
  for (const html of ['<main>Unrelated page</main>', '<main id="courtPoliciesText"><p>Incomplete policies</p></main>']) {
    const harness = createHarness({ responses: [{ html }] });
    harness.api.review(harness.trigger);
    await settle();
    assert.match(harness.textView.innerHTML, /Try again/);
    assert.equal(harness.button.disabled, true);
    harness.clickAgree();
    assert.equal(harness.nodes.courtPoliciesAgree.checked, false);
    assert.equal(harness.dialog.open, true);
  }
});

test('an accepted customer can close a failed text review without revoking agreement', async () => {
  const harness = createHarness({ accepted: true, responses: [new Error('Network unavailable')] });
  harness.api.review(harness.trigger);
  await settle();
  assert.match(harness.textView.innerHTML, /Try again/);
  assert.equal(harness.button.textContent, 'Close');
  assert.equal(harness.button.disabled, false);
  harness.clickAgree();
  assert.equal(harness.dialog.open, false);
  assert.equal(harness.nodes.courtPoliciesAgree.checked, true);
  assert.equal(harness.storage.get(storageKey), 'accepted');
  assert.equal(harness.document.activeElement, harness.trigger);
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
