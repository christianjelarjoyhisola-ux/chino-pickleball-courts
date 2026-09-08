const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ChinoPricing = require('./court-pricing.js');

const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function between(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${start}`);
  return page.slice(from, to);
}

function harness(extra = {}) {
  const context = vm.createContext({
    ChinoPricing, pricingTiers: [], _settingsTiers: [], openHour: 6, closeHour: 24,
    isSeparateBookingFee: () => false, calcSvcFee: () => 0, fmtT: hour => `${hour}:00`, fmtTc: hour => `${hour}:00`,
    fmtDc: date => date, fmtD: date => date, fmt: amount => `₱${amount}`,
    esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ...extra,
  });
  vm.runInContext([
    between('function allInSlotRate(', 'function activeHostSession('),
    between('function getPricingTiersForCourt(', 'const fmtTs ='),
    between('function selectionListedPrice(', 'function bookingSelectionKey('),
    between('function bookingItemFromReservedBooking(', 'function restoreGuestResumeDraft('),
    between('function itemBookingFeeMode(', 'function bookingRentalBreakdownModel('),
    between('function bookingTicketHourLabel(', 'function renderBookingTicketSessions('),
    between('async function verifiedReservedBookingItems(', 'async function proceedToBookLegacy('),
  ].join('\n'), context);
  return context;
}

const promoCourt = (overrides = {}) => ({
  id: 'one', name: 'Court One', rate: 300,
  rateSchedule: [{ from: 6, to: 18, rate: 300 }, { from: 18, to: 6, rate: 400 }],
  promoEnabled: true, promoRate: 150, promoStartDate: '2026-09-08', promoEndDate: '2026-09-10',
  ...overrides,
});
function selection(context, court, date = '2026-09-08', slots = [17, 18]) {
  return { courtId: court.id, courtName: court.name, date, slots, rate: court.rate,
    tiers: context.getPricingTiersForCourt(court), courtPricing: context.courtPricingSnapshot(court) };
}

test('court selection quotes effective play-date rates and snapshots them into booking items', () => {
  const context = harness();
  const court = promoCourt();
  for (const [date, rates] of [
    ['2026-09-07', [300, 400]], ['2026-09-08', [150, 150]],
    ['2026-09-10', [150, 150]], ['2026-09-11', [300, 400]],
  ]) {
    const item = context.makeBookingItemFromSelection(selection(context, court, date), 'TEST');
    assert.deepEqual(plain(item.slotRates), rates);
    assert.equal(item.total, rates.reduce((sum, rate) => sum + rate, 0));
    assert.equal(item.serviceFee, 0);
  }
  const snapshot = selection(context, court);
  court.promoRate = 100;
  court.rateSchedule[0].rate = 999;
  assert.deepEqual(plain(context.selectionSlotRates(snapshot)), [150, 150]);
  assert.equal(snapshot.courtPricing.rateSchedule[0].rate, 300);
});

test('multiple selected courts keep their own promo, scheduled rate and global fallback', () => {
  const context = harness({ _settingsTiers: [{ from: 0, to: 24, rate: 250 }] });
  const selections = [
    selection(context, promoCourt()),
    selection(context, promoCourt({ id: 'two', promoEnabled: false })),
    selection(context, promoCourt({ id: 'three', rateSchedule: null, promoRate: 120 })),
  ];
  context.pricingTiers = [{ from: 0, to: 24, rate: 999 }];
  const items = selections.map(sel => context.makeBookingItemFromSelection(sel));
  assert.deepEqual(items.map(item => item.total), [300, 700, 240]);
  assert.equal(items.reduce((sum, item) => sum + item.total, 0), 1240);
});

test('late-night extension prices midnight on the next play date for each selected court', async () => {
  const context = harness({
    DB: { getBlockedDates: async () => [], getBookings: async () => [] },
    getCourtRepair: () => false, isOpenPlayHour: () => false, isMaintenanceHour: () => false,
    bookingHoldsSlot: () => false,
    addDaysYmd(date, days) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); },
  });
  vm.runInContext(between('function selectedOnlyElevenToMidnight(', 'function closeLateNightExtensionModal('), context);
  const ending = promoCourt({ promoEndDate: '2026-09-08' });
  const starting = promoCourt({ id: 'two', promoStartDate: '2026-09-09' });
  const original = [selection(context, ending, '2026-09-08', [23]), selection(context, starting, '2026-09-08', [23])];
  const extension = await context.lateNightExtensionCandidate(original);
  assert.equal(extension.nextDate, '2026-09-09');
  assert.deepEqual(original.map(sel => context.selectionTotal(sel)), [150, 400]);
  assert.deepEqual(Array.from(extension.selections, sel => context.selectionTotal(sel)), [400, 150]);
  assert.deepEqual(original.map(sel => sel.date), ['2026-09-08', '2026-09-08']);
});

test('Find Time returns discounted totals and crossed-out regular totals for the requested date', async () => {
  const context = harness({
    openHour: 17, closeHour: 19, DB: {
      getCourts: async () => [promoCourt()], getBookings: async () => [], getBlockedDates: async () => [],
    },
    isPublicBookingDateAllowed: () => true, loadOperatingHours: async () => {},
    findTimeBookedMap: () => new Map(), findTimeSlotsAvailable: () => true, jsArg: value => value,
  });
  vm.runInContext(between('async function findAvailableTimeMatches(', 'async function searchAvailableTime('), context);
  const [active] = await context.findAvailableTimeMatches('2026-09-08', 17, 2);
  assert.equal(active.total, 300);
  assert.equal(active.regularTotal, 700);
  assert.match(context.findTimeResultHtml(active), /<del>₱700<\/del>/);
  assert.match(context.findTimeResultHtml(active), /Promo/);
  const [expired] = await context.findAvailableTimeMatches('2026-09-11', 17, 2);
  assert.equal(expired.total, 700);
  assert.doesNotMatch(context.findTimeResultHtml(expired), /<del>|Promo/);
});

test('court cards and slot labels show the regular comparison only for an active discount', () => {
  const context = harness();
  const court = promoCourt();
  const html = context.courtPromoRateHtml(court, '2026-09-08', '₱300–₱400/hr');
  assert.match(html, /Promo/);
  assert.match(html, /<del[^>]*>₱300–₱400\/hr<\/del>/);
  assert.match(html, /<strong>₱150/);
  assert.equal(context.courtPromoRateHtml(court, '2026-09-11', '₱300/hr'), '');
  assert.equal(context.courtPromoRateHtml({ ...court, promoEnabled: false }, '2026-09-08', '₱300/hr'), '');
  assert.match(context.courtPromoSlotPriceHtml(150, 400), /<del[^>]*>₱400<\/del>/);
  assert.equal(context.courtPromoPriceAriaLabel(150, 400), 'Promo ₱150 per hour, regular ₱400 per hour');
  for (const source of [
    between('async function onCardDate(', 'async function ensureCourt('),
    between('async function renderCourts()', 'async function selectCourt('),
  ]) {
    assert.match(source, /courtRateForDate\(c,/);
    assert.match(source, /courtPromoSlotPriceHtml\(baseRate, regularRate\)/);
    assert.match(source, /courtPromoPriceAriaLabel\(baseRate, regularRate\)/);
  }
});

test('saved holds, resumed checkout and tickets use saved rates after the current promo changes', () => {
  const context = harness();
  const item = context.makeBookingItemFromSelection(selection(context, promoCourt()), 'SAVED');
  const saved = { ...plain(item), bookingFeeAmountSnapshot: 0 };
  context.ChinoPricing = {
    rateForHour() { assert.fail('Saved booking must not be repriced'); },
    promoForDate() { assert.fail('Saved booking must not inspect current promo'); },
  };
  const resumed = context.bookingItemFromReservedBooking(saved);
  assert.equal(resumed.total, 300);
  assert.deepEqual(plain(resumed.slotRates), [150, 150]);
  const ticket = context.bookingTicketPricingItems(saved);
  assert.equal(ticket[0].total, 300);
  assert.deepEqual(plain(ticket[0].slotRates), [150, 150]);
  assert.equal(context.bookingItemRateBreakdown(ticket[0]).formula, '₱150/hr × 2 hrs');
  const legacy = context.bookingTicketPricingItems({ ...saved, slotRates: [], total: 650 });
  assert.equal(legacy[0].total, 650);
  assert.equal(context.bookingItemRateBreakdown(legacy[0]).components.length, 0);
});

test('checkout verifies canonical hold prices and rejects a changed quote before accepting payment', async () => {
  let saved;
  const cleared = [];
  const context = harness({ DB: { getBookingByRef: async () => saved, clearCache: scopes => cleared.push(plain(scopes)) } });
  const quoted = context.makeBookingItemFromSelection(selection(context, promoCourt()), 'HOLD');
  saved = { ...plain(quoted), bookingFeeAmountSnapshot: 0 };
  const verified = await context.verifiedReservedBookingItems([quoted]);
  assert.equal(verified[0].total, 300);
  saved = { ...saved, total: 700, slotRates: [300, 400] };
  await assert.rejects(context.verifiedReservedBookingItems([quoted]), /pricing has changed.*review the updated prices/);
  assert.deepEqual(cleared, [['courts', 'settings']]);
  saved = null;
  await assert.rejects(context.verifiedReservedBookingItems([quoted]), /Could not verify/);
  const launch = between('async function proceedToBook(courtId', 'function closeBookModal(');
  assert.ok(launch.indexOf('verifiedReservedBookingItems(reserveItems)') < launch.indexOf("$('bookModal').classList.add('active')"));
  assert.match(launch, /if \(createdRefs.length\) await cancelReservedBookings\(createdRefs\)/);
  assert.match(launch, /slotRates:\s*\[\.\.\.item.slotRates\]/);
});

test('production holds without per-slot columns accept matching totals and retain only a reconciled quote breakdown', async () => {
  let saved;
  const cleared = [];
  const context = harness({ DB: { getBookingByRef: async () => saved, clearCache: scopes => cleared.push(plain(scopes)) } });
  const quoted = context.makeBookingItemFromSelection(selection(context, promoCourt()), 'PRODUCTION-HOLD');
  saved = {
    ref: quoted.ref, courtId: quoted.courtId, courtName: quoted.courtName,
    date: quoted.date, slots: [...quoted.slots], duration: quoted.duration,
    rate: 300, total: 300, bookingFeeAmountSnapshot: 0,
  };
  assert.equal(Object.hasOwn(saved, 'slotRates'), false);
  assert.equal(Object.hasOwn(saved, 'slot_rates'), false);
  const [verified] = await context.verifiedReservedBookingItems([quoted]);
  assert.equal(verified.total, 300);
  assert.deepEqual(plain(verified.slotRates), [150, 150]);
  assert.notEqual(verified.slotRates, quoted.slotRates, 'checkout owns a copied breakdown');
  assert.equal(Object.hasOwn(saved, 'slotRates'), false, 'verification must not change the saved row');
  const [withoutBreakdown] = await context.verifiedReservedBookingItems([{ ...quoted, slotRates: [150, 200] }]);
  assert.equal(withoutBreakdown.total, 300);
  assert.deepEqual(plain(withoutBreakdown.slotRates), [], 'a breakdown that differs from the saved total must not be shown');
  saved.total = 700;
  await assert.rejects(context.verifiedReservedBookingItems([quoted]), /pricing has changed.*review the updated prices/);
  assert.deepEqual(cleared, [['courts', 'settings']]);
});

test('public pricing assets load before inline consumers and all scripts parse', () => {
  assert.ok(page.indexOf('court-pricing.js?v=') < page.indexOf('function selectionSlotRates('));
  assert.match(page, /promo-pricing\.css\?v=/);
  for (const match of page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=|application\/ld\+json/i.test(match[1])) new vm.Script(match[2]);
  }
});

test('separate hourly fee reconciles selection, stored hold and court-only receipt breakdown', async () => {
  const context = harness({isSeparateBookingFee:()=>true, calcSvcFee:hours=>hours*15});
  const court = promoCourt({promoEnabled:false,rate:365,rateSchedule:[{from:0,to:24,rate:365}]});
  const item = context.makeBookingItemFromSelection(selection(context,court,'2026-09-10',[10,11]),'FEE-TEST');
  assert.equal(item.total,760);
  assert.equal(item.courtFee,730);
  assert.equal(item.serviceFee,30);
  assert.equal(item.feeMode,'separate');
  assert.equal(context.allInSlotRate(365),380);
  context.DB = {getBookingByRef:async()=>({...plain(item),bookingFeeModeSnapshot:'separate',bookingFeeAmountSnapshot:30,slotRates:[]})};
  const [saved] = await context.verifiedReservedBookingItems([item]);
  assert.equal(saved.total,760);
  assert.deepEqual(plain(saved.slotRates),[365,365]);
  assert.equal(context.bookingItemRateBreakdown(saved).total,730);
  // Historical included bookings must not acquire the newly enabled separate fee.
  const historical = context.bookingItemFromReservedBooking({...plain(item),total:730,bookingFeeModeSnapshot:'included',bookingFeeAmountSnapshot:30});
  assert.equal(context.bookingItemRateBreakdown(historical).total,730);
});
