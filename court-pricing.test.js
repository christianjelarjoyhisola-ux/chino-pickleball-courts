const assert = require('node:assert/strict');
const test = require('node:test');
const pricing = require('./court-pricing.js');

const court = {
  rate: 300,
  promoEnabled: true,
  promoRate: 250,
  promoStartDate: '2026-09-10',
  promoEndDate: '2026-09-20',
};

test('promos use inclusive play-date boundaries, with no date treated as regular pricing', () => {
  for (const [date, expected] of [['2026-09-09', 300], ['2026-09-10', 250], ['2026-09-20', 250], ['2026-09-21', 300], [undefined, 300]]) {
    assert.equal(pricing.rateForHour(court, 8, date), expected);
  }
});

test('turning a promo off or leaving either date open works without changing regular rates', () => {
  assert.equal(pricing.rateForHour({ ...court, promoEnabled: false }, 8, '2026-09-15'), 300);
  assert.equal(pricing.rateForHour({ ...court, promoStartDate: null }, 8, '2026-01-01'), 250);
  assert.equal(pricing.rateForHour({ ...court, promoEndDate: null }, 8, '2027-01-01'), 250);
  assert.equal(pricing.rateForHour({ ...court, promoStartDate: null, promoEndDate: null }, 8, '2027-01-01'), 250);
});

test('regular pricing preserves court/global precedence, tier boundaries, overnight and minimum gap rate', () => {
  const tiers = [{ from: 6, to: 18, rate: 350 }, { from: 18, to: 23, rate: 450 }];
  const scheduled = { ...court, promoEnabled: false, rateSchedule: tiers };
  assert.equal(pricing.rateForHour(scheduled, 17, '2026-09-15'), 350);
  assert.equal(pricing.rateForHour(scheduled, 18, '2026-09-15'), 450);
  assert.equal(pricing.rateForHour(scheduled, 2, '2026-09-15'), 350);
  assert.equal(pricing.regularRateForHour({ rate: 300 }, 18, tiers), 450);
  assert.equal(pricing.regularRateForHour(scheduled, 18, [{ from: 0, to: 24, rate: 999 }]), 450);
  const overnight = { rateSchedule: [{ from: 20, to: 6, rate: 500 }, { from: 6, to: 20, rate: 350 }] };
  assert.equal(pricing.regularRateForHour(overnight, 0), 500);
  assert.equal(pricing.regularRateForHour(overnight, 6), 350);
});

test('one promo replaces tiered rates and can never increase a slot after regular settings change', () => {
  const mixed = { ...court, rateSchedule: [{ from: 6, to: 18, rate: 300 }, { from: 18, to: 24, rate: 400 }] };
  assert.deepEqual([17, 18].map(hour => pricing.rateForHour(mixed, hour, '2026-09-15')), [250, 250]);
  assert.equal(pricing.rateForHour({ ...court, rate: 200 }, 8, '2026-09-15'), 200);
});

test('invalid promo drafts and real calendar dates are rejected without accidental discounts', () => {
  for (const promoRate of [null, '', 0, -1, NaN, Infinity, 'not a price']) {
    const invalid = { ...court, promoRate };
    assert.ok(pricing.validatePromo(invalid));
    assert.equal(pricing.rateForHour(invalid, 8, '2026-09-15'), 300);
  }
  assert.ok(pricing.validatePromo({ ...court, promoRate: 250.001 }));
  assert.ok(pricing.validatePromo({ ...court, promoRate: 300 }));
  assert.ok(pricing.validatePromo({ ...court, promoStartDate: '2026-02-30' }));
  assert.ok(pricing.validatePromo({ ...court, promoStartDate: '2026-09-21' }));
  assert.equal(pricing.validatePromo({ ...court, promoEnabled: false, promoRate: null }), '');
  assert.equal(pricing.validatePromo(court), '');
  assert.equal(pricing.validDate('2028-02-29'), true);
  assert.equal(pricing.validDate('2026-02-29'), false);
});

test('validation uses the active schedule instead of an unused base price', () => {
  const tiered = { ...court, rate: 100, rateSchedule: [{ from: 0, to: 24, rate: 350 }] };
  assert.equal(pricing.validatePromo(tiered), '');
  assert.ok(pricing.validatePromo(court, [{ from: 0, to: 24, rate: 200 }]));
});

test('next-day selections switch promo eligibility at midnight and Philippine dates are stable', () => {
  const dates = ['2026-09-20', '2026-09-21'];
  assert.deepEqual(dates.map((date, i) => pricing.rateForHour(court, i ? 0 : 23, date)), [250, 300]);
  assert.equal(pricing.todayInManila('2026-09-09T16:00:00Z'), '2026-09-10');
  assert.equal(pricing.todayInManila('2026-09-09T15:59:59Z'), '2026-09-09');
});

test('snake-case database records and distinct courts produce independent quotes without mutation', () => {
  const raw = { rate: '300', promo_enabled: true, promo_rate: '240.50', promo_start_date: null, promo_end_date: null };
  const before = JSON.stringify(raw);
  assert.equal(pricing.rateForHour(raw, 10, '2026-09-15'), 240.5);
  assert.equal(pricing.rateForHour({ rate: 400 }, 10, '2026-09-15'), 400);
  assert.equal(JSON.stringify(raw), before);
});
