const test = require('node:test');
const assert = require('node:assert/strict');
const Activity = require('./admin-activity.js');
const catalogs = ['operations', 'management', 'accounts'].map(name => require(`./admin-activity-${name}.js`));

function element(code = '', options = {}) {
  return { tagName: 'BUTTON', closest: () => null, matches: () => false, getAttribute: name => name === 'onclick' ? code : null, hasAttribute: () => false, value: 'private-password', textContent: 'Private customer name', ...options };
}
function observerHarness(feedback = {}) {
  let session = { id: 'operator', role: 'court_owner', status: 'active' };
  const events = [], listeners = {}, mutations = [];
  const panel = { hidden: true, id: 'courtModal', getAttribute: () => null, getClientRects: () => panel.hidden ? [] : [{}] };
  const doc = { body: {}, activeElement: null, querySelectorAll: () => [panel], addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener() {}, defaultView: {
    addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ visibility: 'visible' }),
    MutationObserver: class { constructor(fn) { this.fn = fn; mutations.push(this); } observe() {} disconnect() { this.stopped = true; } }, ...feedback,
  } };
  const observer = Activity.createObserver({ db: { recordAdminActivity: event => events.push(event) }, getSession: () => session });
  observer.install(doc); observer.observeNavigation('courts'); events.length = 0;
  const click = control => listeners.click({ isTrusted: true, target: { closest: () => control } });
  return { observer, events, listeners, mutations, panel, doc, click, session: value => { session = value; } };
}

test('all fourteen sidebar pages have named controls that route without capturing contents', () => {
  const rules = catalogs.flatMap(catalog => catalog.controls);
  const pages = ['dash', 'insights', 'bookings', 'payreview', 'reports', 'courts', 'gamemgr', 'hosts', 'maintenance', 'payments', 'accounts', 'remittances', 'activity', 'deleted'];
  for (const page of pages) {
    const rule = rules.find(candidate => candidate.page === page);
    assert.ok(rule, `Missing controls for ${page}`);
    const control = element('', { matches: selector => selector === rule.selector });
    const observed = Activity.observationFor(control, rule.event);
    assert.equal(observed.action, rule.action);
    assert.equal(observed.page, page);
    const row = Activity.itemMarkup({ source: 'client_reported', action: observed.action, outcome: 'attempted', details: { page, event: 'action_attempt', controlEvent: rule.event } }, 0);
    assert.ok(row.includes(rule.label.replace(/&/g, '&amp;')));
    assert.doesNotMatch(JSON.stringify(observed), /private-password|Private customer/);
  }
});

test('click, actual panel opening, and later closure are separate truthful results', () => {
  const h = observerHarness();
  h.click(element('openCourtModal("private-id")'));
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].controlEvent, 'click');
  assert.equal(h.events[0].outcome, 'attempt');
  h.mutations[0].fn();
  assert.equal(h.events.length, 1, 'Hidden panel must not report Opened');
  h.panel.hidden = false; h.mutations[0].fn();
  assert.equal(h.events[1].uiResult, 'opened');
  h.observer.observeNavigation('payments');
  h.panel.hidden = true; h.mutations[0].fn();
  assert.equal(h.events.at(-1).uiResult, 'closed');
  assert.equal(h.events.at(-1).page, 'courts');
  assert.equal(h.events.at(-1).action, 'closePanel');
  assert.doesNotMatch(JSON.stringify(h.events), /private-id|private-password/);
  h.observer.destroy();
});

test('late panel changes cannot be attributed to a replacement account', () => {
  const h = observerHarness(); h.click(element('openCourtModal()'));
  h.session({ id: 'replacement', role: 'owner' });
  h.panel.hidden = false; h.mutations[0].fn();
  assert.equal(h.events.length, 1);
  assert.equal(h.mutations[0].stopped, true);
  h.observer.destroy();
});

test('details toggles and native validation report observed results without form data', async () => {
  const h = observerHarness();
  const detail = { tagName: 'DETAILS', open: false };
  const rule = catalogs.flatMap(c => c.controls).find(r => r.selector.includes('summary'));
  const summary = element('', { tagName: 'SUMMARY', parentElement: detail, matches: selector => selector === rule.selector });
  h.click(summary); detail.open = true; h.listeners.toggle({ target: detail });
  assert.equal(h.events.at(-1).uiResult, 'expanded');
  h.click(element('saveCourt()')); h.listeners.invalid({ target: { value: 'sensitive' } });
  assert.equal(h.events.at(-1).uiResult, 'validation_failed');
  const count = h.events.length;
  await Promise.resolve(); h.listeners.invalid({ target: { value: 'sensitive' } });
  assert.equal(h.events.length, count);
  assert.doesNotMatch(JSON.stringify(h.events), /sensitive|private-password/);
  h.observer.destroy();
});

test('plain result labels do not turn clicks, errors, or unknown results into saved changes', () => {
  const item = { source: 'client_reported', outcome: 'attempted', details: { event: 'action_attempt', controlEvent: 'click' } };
  assert.equal(Activity.sourceLabel(item).label, 'Clicked');
  assert.equal(Activity.sourceLabel({ ...item, outcome: 'failed' }).label, 'Failed');
  assert.equal(Activity.sourceLabel({ ...item, outcome: 'success' }).label, 'Completed');
  assert.equal(Activity.sourceLabel({ source: 'client_reported', outcome: 'attempted', details: { event: 'action_result' } }).label, 'Result unknown');
  assert.equal(Activity.sourceLabel({ source: 'database_change', outcome: 'success' }).label, 'Saved');
});

test('an unannotated submit button is associated with its named form before native validation', () => {
  const h = observerHarness();
  const form = element('', { tagName: 'FORM', matches: selector => selector === '[data-pm-form="setup"]', getAttribute: name => name === 'data-pm-form' ? 'setup' : null });
  const button = element('', { type: 'submit', form });
  h.click(button); h.listeners.invalid({ target: { form, value: 'do not collect' } });
  assert.equal(h.events[0].controlEvent, 'click');
  assert.equal(h.events.at(-1).uiResult, 'validation_failed');
  assert.doesNotMatch(JSON.stringify(h.events), /do not collect/);
  h.observer.destroy();
});

test('confirmation and clipboard outcomes preserve browser behavior without recording contents', async () => {
  const originalConfirm = () => false, originalCopy = async () => 'copied-result';
  const h = observerHarness({ confirm: originalConfirm, navigator: { clipboard: { writeText: originalCopy } } });
  h.click(element('deleteCourt()'));
  assert.equal(h.doc.defaultView.confirm('Private confirmation text'), false);
  assert.equal(h.events.at(-1).uiResult, 'cancelled');
  h.click(element('copyHostSessionLink()'));
  assert.equal(await h.doc.defaultView.navigator.clipboard.writeText('private link'), 'copied-result');
  assert.equal(h.events.at(-1).uiResult, 'copied');
  assert.doesNotMatch(JSON.stringify(h.events), /Private confirmation|private link/);
  h.observer.destroy();
  assert.equal(h.doc.defaultView.confirm, originalConfirm);
  assert.equal(h.doc.defaultView.navigator.clipboard.writeText, originalCopy);
});

test('new navigation stops a pending opener before it can be confused with a later panel', () => {
  const h = observerHarness(); h.click(element('openCourtModal()'));
  h.observer.observeNavigation('payments');
  assert.equal(h.mutations[0].stopped, true);
  h.observer.destroy();
});

test('closing the opened panel is recorded even when another selector alternative becomes visible', () => {
  const h = observerHarness();
  const grouped = { hidden: true, id: 'groupRescheduleModal', getAttribute: () => null, getClientRects: () => grouped.hidden ? [] : [{}] };
  h.panel.id = 'rescheduleModal';
  h.doc.querySelectorAll = selector => {
    assert.equal(selector, '#rescheduleModal, #groupRescheduleModal');
    return [h.panel, grouped];
  };
  h.click(element('openRescheduleModal()'));
  grouped.hidden = false; h.mutations[0].fn();
  assert.equal(h.events.at(-1).uiResult, 'opened');
  // A new alternative is now visible, but the one actually opened is closed.
  grouped.hidden = true; h.panel.hidden = false; h.mutations[0].fn();
  assert.equal(h.events.at(-1).uiResult, 'closed');
  assert.equal(h.events.at(-1).targetId, 'groupRescheduleModal');
  assert.equal(h.mutations[0].stopped, true);
  h.observer.destroy();
});

test('clipboard rejection preserves fallback behavior without falsely recording a failed copy', async () => {
  for (const synchronous of [false, true]) {
    const failure = new Error('Private clipboard failure details');
    const originalCopy = synchronous ? () => { throw failure; } : () => Promise.reject(failure);
    const h = observerHarness({ navigator: { clipboard: { writeText: originalCopy } } });
    h.click(element('hostCopy()'));
    let fallbackCopied = false;
    try { await h.doc.defaultView.navigator.clipboard.writeText('private copy contents'); }
    catch (error) { assert.equal(error, failure); fallbackCopied = true; }
    assert.equal(fallbackCopied, true, 'Caller retains the original failure and can run its copy fallback');
    assert.equal(h.events.length, 1, 'The API failure does not prove that the complete copy action failed');
    assert.equal(h.events[0].controlEvent, 'click');
    assert.doesNotMatch(JSON.stringify(h.events), /private copy|Private clipboard/);
    h.observer.destroy();
    assert.equal(h.doc.defaultView.navigator.clipboard.writeText, originalCopy);
  }
});

test('share cancellation and failures still preserve their specific observed outcomes', async () => {
  for (const name of ['AbortError', 'NotAllowedError']) {
    const failure = Object.assign(new Error('Private share content'), { name });
    const originalShare = () => Promise.reject(failure);
    const h = observerHarness({ navigator: { share: originalShare } });
    h.click(element('', { matches: selector => selector === '[data-prag-action="share"]' }));
    await assert.rejects(h.doc.defaultView.navigator.share({ text: 'private share text' }), error => error === failure);
    assert.equal(h.events.at(-1).outcome, name === 'AbortError' ? 'skipped' : 'failed');
    assert.equal(h.events.at(-1).uiResult, name === 'AbortError' ? 'cancelled' : undefined);
    assert.doesNotMatch(JSON.stringify(h.events), /Private share|private share/);
    h.observer.destroy();
    assert.equal(h.doc.defaultView.navigator.share, originalShare);
  }
});
