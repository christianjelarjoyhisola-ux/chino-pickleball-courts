const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pricing = require('./court-pricing.js');
const page = fs.readFileSync('admin.html', 'utf8');

function source(name) {
  const expression = new RegExp('^(?:async )?function ' + name + '\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^\\}', 'gm');
  const matches = [...page.matchAll(expression)];
  assert.ok(matches.length, `Missing ${name}`);
  return matches.at(-1)[0];
}

function editorHarness({ role = 'owner', court = null, tiers = [] } = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value:'', checked:false, focus() { this.focused = true; } });
    return nodes.get(id);
  };
  const saved = [], notices = [];
  Object.assign(get('cmId'), { value:court?.id || '' });
  Object.assign(get('cmName'), { value:court?.name || 'Court Blue' });
  Object.assign(get('cmRate'), { value:'350' });
  Object.assign(get('cmPromoEnabled'), { checked:true });
  Object.assign(get('cmPromoRate'), { value:'250' });
  Object.assign(get('cmPromoStartDate'), { value:'2026-10-01' });
  Object.assign(get('cmPromoEndDate'), { value:'2026-10-31' });
  const context = vm.createContext({
    sess:{ role }, $:get, window:{ ChinoPricing:pricing }, courtPromoFallbackTiers:tiers,
    _readTiers:() => null,
    DB:{ getCourts:async () => court ? [court] : [], saveCourt:async row => saved.push(row) },
    toast:(message, level) => notices.push({ message, level }),
    updateCourtPromoPreview:() => {}, closeModal:() => {}, renderCourts:async () => {},
  });
  vm.runInContext(['canManageCourtPromo','courtPromoDraft','saveCourt'].map(source).join('\n'), context);
  return { context, get, saved, notices };
}

test('both owner roles can save a dated per-court promo without replacing unrelated court data', async () => {
  for (const role of ['owner', 'court_owner']) {
    const court = { id:'court-blue', name:'Court Blue', rate:350, blocked:true, feats:['lights'], photo:'court.png' };
    const harness = editorHarness({ role, court });
    await harness.context.saveCourt();
    assert.equal(harness.saved.length, 1);
    const saved = harness.saved[0];
    assert.equal(saved.id, court.id);
    assert.equal(saved.blocked, true);
    assert.deepEqual(saved.feats, ['lights']);
    assert.equal(saved.promoEnabled, true);
    assert.equal(saved.promoRate, 250);
    assert.equal(saved.promoStartDate, '2026-10-01');
    assert.equal(saved.promoEndDate, '2026-10-31');
  }
});

test('court saving rejects an invalid promo against effective global tiers before any write', async () => {
  const harness = editorHarness({ tiers:[{ from:6, to:18, rate:200 }, { from:18, to:24, rate:300 }] });
  await harness.context.saveCourt();
  assert.equal(harness.saved.length, 0);
  assert.ok(harness.notices.some(notice => notice.level === 'err'));
  assert.equal(harness.get('cmPromoRate').focused, true);
  harness.get('cmPromoRate').value = '150';
  harness.get('cmPromoEndDate').value = '2026-09-30';
  await harness.context.saveCourt();
  assert.equal(harness.saved.length, 0);
});

test('disabling a promo remains possible when its saved draft is invalid', async () => {
  const harness = editorHarness();
  harness.get('cmPromoEnabled').checked = false;
  harness.get('cmPromoRate').value = '-1';
  harness.get('cmPromoEndDate').value = '2026-09-30';
  await harness.context.saveCourt();
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].promoEnabled, false);
  assert.equal(harness.saved[0].promoRate, null);
  assert.equal(harness.saved[0].promoStartDate, null);
  assert.equal(harness.saved[0].promoEndDate, null);
  harness.get('cmPromoRate').value = 'not-a-number';
  harness.get('cmPromoStartDate').value = '2026-02-30';
  harness.get('cmPromoEndDate').value = 'not-a-date';
  await harness.context.saveCourt();
  assert.equal(harness.saved.length, 2);
  assert.equal(harness.saved[1].promoRate, null);
  assert.equal(harness.saved[1].promoStartDate, null);
  assert.equal(harness.saved[1].promoEndDate, null);
});

test('turning off a saved promo preserves valid settings even after regular rates drop', async () => {
  const court = { id:'blue', name:'Blue', rate:350, promoEnabled:true, promoRate:250, promoStartDate:'2026-10-01', promoEndDate:'2026-10-31' };
  const harness = editorHarness({ court, tiers:[{ from:0, to:24, rate:200 }] });
  harness.get('cmPromoEnabled').checked = false;
  await harness.context.saveCourt();
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].promoEnabled, false);
  assert.equal(harness.saved[0].promoRate, court.promoRate);
  assert.equal(harness.saved[0].promoStartDate, court.promoStartDate);
  assert.equal(harness.saved[0].promoEndDate, court.promoEndDate);
});

test('court list compares promos with effective regular tiers and clears stale global tiers', async () => {
  const body = { innerHTML:'' };
  const courts = [{ id:'blue', name:'Blue', desc:'', rate:300, promoEnabled:true, promoRate:100 }];
  let settings = { pricing_tiers:JSON.stringify([{ from:0, to:24, rate:365 }]) };
  const context = vm.createContext({
    window:{ ChinoPricing:pricing }, $:id => id === 'courtBody' ? body : null,
    courtPromoFallbackTiers:[], adminTiers:[], fmt:amount => `₱${amount}`, esc:value => String(value ?? ''), jsArg:value => String(value),
    DB:{ getCourts:async () => courts, getSettings:async () => settings },
    renderVenueDetailsSettings:async () => {}, renderHours:async () => {}, renderMaintRateSettings:async () => {}, renderPaymentSettings:async () => {}, renderTiersUI:() => {},
  });
  vm.runInContext(['parsePricingTiers','loadPricingTiers','courtPromoToday','courtAdminRateLabel','courtPromoListHtml','renderCourts'].map(source).join('\n'), context);
  await context.renderCourts();
  assert.match(body.innerHTML, /data-label="Rate">₱365\/hr/);
  assert.match(body.innerHTML, /Promo active[\s\S]*₱100\/hr/);
  courts[0].rateSchedule = [{ from:0, to:12, rate:280 }, { from:12, to:24, rate:340 }];
  await context.renderCourts();
  assert.match(body.innerHTML, /data-label="Rate">₱280–₱340\/hr/);
  courts[0].rateSchedule = null;
  settings = {};
  await context.renderCourts();
  assert.match(body.innerHTML, /data-label="Rate">₱300\/hr/);
  assert.doesNotMatch(body.innerHTML, /₱365/);
});

test('non-owner roles cannot change saved promo settings by manipulating editor fields', async () => {
  for (const role of ['staff', 'host', '']) {
    const court = { id:'court-blue', name:'Court Blue', rate:350, promoEnabled:false, promoRate:null, promoStartDate:null, promoEndDate:null };
    const harness = editorHarness({ role, court });
    await harness.context.saveCourt();
    assert.equal(harness.saved.length, 1);
    assert.equal(harness.saved[0].promoEnabled, false);
    assert.equal(harness.saved[0].promoRate, null);
    assert.equal(harness.saved[0].promoStartDate, null);
    assert.equal(harness.saved[0].promoEndDate, null);
  }
});

test('manual bookings use the selected play date and preserve per-slot prices for mixed courts', () => {
  const promo = { id:'blue', name:'Blue', rate:350, promoEnabled:true, promoRate:150, promoStartDate:'2026-10-01', promoEndDate:'2026-10-31' };
  const regular = { id:'stone', name:'Stone', rate:400, rateSchedule:[{ from:6, to:24, rate:300 }] };
  const date = { value:'2026-10-31' };
  const context = vm.createContext({
    window:{ ChinoPricing:pricing }, $:id => id === 'nbDate' ? date : null,
    _nbPricingTiers:[{ from:6, to:24, rate:250 }], _nbCourts:[promo, regular],
    _nbPlatformFeeCfg:{ amount:10, type:'per_hour' },
    nbSelectedEntries:() => [{ courtId:'blue', hour:8 }, { courtId:'blue', hour:9 }, { courtId:'stone', hour:8 }],
  });
  vm.runInContext(['_nbGetRateForHour','_nbBookingFeeForHours','nbSelectionGroups','nbGroupsWithFees'].map(source).join('\n'), context);
  const groups = context.nbGroupsWithFees();
  assert.equal(groups.length, 2);
  assert.deepEqual(Array.from(groups[0].slotRates), [150, 150]);
  assert.equal(groups[0].total, 300);
  assert.equal(groups[0].bookingFee, 20);
  assert.equal(groups[0].courtFee, 280);
  assert.equal(groups[1].total, 300);
  date.value = '2026-11-01';
  const afterPromo = context.nbGroupsWithFees();
  assert.equal(afterPromo[0].total, 500);
  assert.deepEqual(Array.from(afterPromo[0].slotRates), [250, 250]);
  assert.equal(context._nbGetRateForHour(promo, 8, '2026-10-01'), 150);
  assert.equal(context._nbGetRateForHour(promo, 8, '2026-09-30'), 250);
});
