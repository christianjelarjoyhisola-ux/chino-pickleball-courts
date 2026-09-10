'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReportOptions } = require('./receipt-feedback-report.cjs');

test('legacy GCash report invocation remains compatible', () => {
  assert.deepEqual(parseReportOptions(['--layout=gcash_express_send', '--revision=gcash_adaptive_20260910']), {
    layout: 'gcash_express_send', revision: 'gcash_adaptive_20260910', days: 30,
  });
});
test('provider preference requires complete route/layout/revision scope', () => {
  assert.deepEqual(parseReportOptions(['--provider=maya', '--destination=gcash', '--layout=maya_sent_money_v1', '--revision=bank_adaptive_20260910', '--days=7']), {
    provider: 'maya', destination: 'gcash', layout: 'maya_sent_money_v1', revision: 'bank_adaptive_20260910', days: 7,
  });
  for (const args of [['--provider=maya'], ['--destination=gcash'], ['--provider=maya', '--destination=gcash'], ['--layout=maya_sent_money_v1']]) {
    assert.throws(() => parseReportOptions(args));
  }
});
test('unknown providers, arbitrary flags and ambiguous duplicated scopes are rejected', () => {
  for (const args of [
    ['--provider=pnb', '--destination=gcash', '--layout=pnb_v1', '--revision=test'],
    ['--write=true'], ['--days=30', '--days=60'], ['--days='], ['--days=0'], ['--days=366'],
    ['--layout=maya_sent_money_v1', '--revision=revision with spaces'],
    ['--layout=maya_sent_money_v1', `--revision=${'x'.repeat(101)}`],
  ]) assert.throws(() => parseReportOptions(args));
});
test('private reconciliation labels remain a read-only optional input', () => {
  assert.equal(parseReportOptions(['--labels-file=.private/labels.json'])['labels-file'], '.private/labels.json');
});
