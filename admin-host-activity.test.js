const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const admin = fs.readFileSync('admin.html', 'utf8');
const activity = require('./admin-activity.js');
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function functionSource(name) {
  const start = admin.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} must exist`);
  const tail = admin.slice(start);
  const end = tail.search(/\r?\n(?:async )?function /);
  return end < 0 ? tail : tail.slice(0, end);
}

function renderedControls(markup) {
  return [...markup.matchAll(/<(button|input|summary)\b[^>]*\bdata-activity-action="[^"]+"[^>]*>/g)].map(match => {
    const attributes = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]]));
    return {
      tagName: match[1].toUpperCase(),
      id: attributes.id || '',
      value: attributes.value || '',
      getAttribute: name => attributes[name] ?? null,
      hasAttribute: name => Object.hasOwn(attributes, name),
      closest: () => null,
    };
  });
}

function renderer(name, globals = {}) {
  const nodes = new Map();
  const context = vm.createContext({
    $: id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '' }); return nodes.get(id); },
    esc: escape,
    jsArg: escape,
    accountInitials: () => 'H',
    accountCreatedLabel: () => 'Joined today',
    fmt: amount => `PHP ${amount}`,
    ACCOUNT_ROLE_LABELS: { host: 'Open Play Host', staff: 'Court Staff' },
    ACCOUNT_ROLE_BADGES: { host: 'bdg-v', staff: 'bdg-d' },
    console,
    ...globals,
  });
  vm.runInContext(functionSource(name), context);
  return { context, nodes };
}

test('court owner host directory reports viewing bookings and balances without implying account-management access', async () => {
  const { context, nodes } = renderer('renderAccounts', {
    sess: { id: 'court-owner', role: 'court_owner' },
    Auth: { can: () => false },
    DB: { getHostFinanceAccounts: async () => [
      { id: 'host-private-id', fullName: 'PRIVATE HOST NAME', email: 'private-host@example.test', role: 'host' },
      { id: 'staff-private-id', fullName: 'Private staff', role: 'staff' },
    ] },
  });
  await context.renderAccounts();
  const html = nodes.get('accBody').innerHTML;
  const controls = renderedControls(html);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].getAttribute('data-activity-action'), 'host_account_open');
  assert.equal(controls[0].getAttribute('data-activity-page'), 'accounts');
  assert.doesNotMatch(html, />Edit<|>Delete<|Private staff/);
  const event = activity.observationFor(controls[0], 'click');
  assert.ok(event);
  assert.equal(event.action, 'host_account_open');
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE HOST NAME|private-host@example|host-private-id|saved|success/i);
});

test('host booking searches and all five filters have stable page actions and never record a search query', () => {
  const { context, nodes } = renderer('renderHostAccountDetails', {
    _hostFinanceState: { account: { fullName: 'PRIVATE HOST NAME', email: 'private-host@example.test' }, bookings: [], filter: 'all', query: 'PRIVATE SEARCH VALUE' },
    hostFinanceFilterCount: () => 0,
    renderHostFinanceBookingResults: () => {},
  });
  context.renderHostAccountDetails();
  const controls = renderedControls(nodes.get('hostAccountBody').innerHTML);
  const search = controls.find(control => control.id === 'hostAccountSearch');
  assert.ok(search);
  assert.equal(search.getAttribute('data-activity-event'), 'change');
  assert.equal(activity.observationFor(search, 'click'), null);
  assert.equal(activity.observationFor(search, 'input'), null);
  const searchEvent = activity.observationFor(search, 'change');
  assert.ok(searchEvent);
  assert.equal(searchEvent.action, 'host_bookings_search');
  assert.doesNotMatch(JSON.stringify(searchEvent), /PRIVATE SEARCH VALUE|PRIVATE HOST NAME|private-host@example/);
  for (const filter of ['all', 'upcoming', 'balance', 'review', 'history']) {
    const control = controls.find(item => item.getAttribute('data-activity-action') === `host_bookings_filter_${filter}`);
    assert.ok(control, `${filter} filter must be tracked`);
    assert.equal(control.getAttribute('data-activity-page'), 'accounts');
    const event = activity.observationFor(control, 'click');
    assert.equal(event.action, `host_bookings_filter_${filter}`);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE SEARCH VALUE|PRIVATE HOST NAME|private-host@example/);
  }
});

test('keyboard host filters record the selected filter once without blocking navigation on logging failure', async () => {
  const records = [];
  const clicks = [];
  const focus = [];
  const tabs = ['all', 'upcoming', 'balance', 'review', 'history'].map(filter => ({
    dataset: { activityAction: `host_bookings_filter_${filter}` },
    click: () => clicks.push(filter),
    focus: () => focus.push(filter),
  }));
  const { context } = renderer('hostFinanceTabKeydown', {
    document: { querySelectorAll: () => tabs },
    DB: { recordAdminActivity: event => { records.push(event); return Promise.reject(new Error('Offline')); } },
  });
  context.hostFinanceTabKeydown({ key: 'ArrowRight', currentTarget: tabs[0], isTrusted: true, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(clicks, ['upcoming']);
  assert.deepEqual(focus, ['upcoming']);
  assert.equal(records.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(records[0])), { category: 'interaction', action: 'host_bookings_filter_upcoming', page: 'accounts', outcome: 'attempt' });

  context.hostFinanceTabKeydown({ key: 'ArrowRight', currentTarget: tabs[0], isTrusted: false, preventDefault() {} });
  assert.equal(records.length, 1, 'synthetic key events must not add activity');
  tabs[1].dataset.activityAction = 'untrusted_private_value';
  context.hostFinanceTabKeydown({ key: 'ArrowRight', currentTarget: tabs[0], isTrusted: true, preventDefault() {} });
  assert.equal(records.length, 1, 'only known filter identifiers may be recorded');
});
