const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const catalog = require('./admin-activity-management');

test('every delegated Play Manager action and form has a named activity entry', () => {
  const source = fs.readFileSync(require.resolve('./play-manager.js'), 'utf8');
  const actions = new Set([...source.matchAll(/data-pm-action="([a-z-]+)"/g)].map(match => match[1]));
  const forms = new Set([...source.matchAll(/data-pm-form="([a-z-]+)"/g)].map(match => match[1]));
  for (const action of actions) {
    assert.ok(catalog.controls.some(item => item.selector === `[data-pm-action="${action}"]` && item.event === 'click'), `Missing Play Manager action: ${action}`);
  }
  for (const form of forms) {
    assert.ok(catalog.controls.some(item => item.selector === `[data-pm-form="${form}"]` && item.event === 'submit'), `Missing Play Manager form: ${form}`);
  }
  assert.ok(catalog.controls.some(item => item.selector === '#pm2OpenLiveView' && item.event === 'click'));
});

test('management activity controls use stable labels without values or typing capture', () => {
  const identifiers = new Set();
  for (const item of catalog.controls) {
    assert.match(item.action, /^[a-z][a-z0-9_]+$/);
    assert.ok(!identifiers.has(item.action), `Duplicate action identifier: ${item.action}`);
    identifiers.add(item.action);
    assert.ok(['click', 'change', 'submit'].includes(item.event));
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 5);
    assert.equal(Object.hasOwn(item, 'value'), false);
    assert.equal(Object.hasOwn(item, 'textContent'), false);
    assert.equal(Object.hasOwn(item, 'innerHTML'), false);
    assert.ok(!/\[value\^?=/i.test(item.selector));
  }
  const receiptDestination = catalog.controls.find(item => item.selector === '#gcashQrReceiptTokenInput');
  assert.equal(receiptDestination.event, 'change');
  assert.match(receiptDestination.label, /draft/);
  const sharedCourtEditor = catalog.controls.find(item => item.selector === '#cmName');
  assert.equal(Object.hasOwn(sharedCourtEditor, 'page'), false);
  assert.match(catalog.handlers.toggleBlock, /Pause or resume/);
  assert.match(catalog.handlers.mtDeleteRule, /draft/);
});

test('live management page buttons are covered without treating previews as saved changes', () => {
  const source = fs.readFileSync(require.resolve('./admin.html'), 'utf8');
  for (const [start, end] of [
    ['<div id="sec-courts"', '<div id="sec-accounts"'],
    ['<div id="sec-payments"', '<!-- ACCOUNT MODAL -->'],
  ]) {
    const from = source.indexOf(start);
    const section = source.slice(from, source.indexOf(end, from));
    for (const match of section.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)) {
      const handler = match[1];
      if (['goto', 'closeModal'].includes(handler)) continue;
      assert.ok(catalog.handlers[handler], `Missing management button: ${handler}`);
    }
  }
  assert.match(catalog.operations.correctOpenPlayGameMatchWinner, /Correct a match winner/);
  assert.match(catalog.operations.setOpenPlayGamePublicShare, /sharing/);
  assert.match(catalog.handlers.savePaymentSettings, /payment methods and recipient details/);
});
