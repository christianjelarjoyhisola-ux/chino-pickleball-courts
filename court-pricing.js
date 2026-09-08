(function (root, factory) {
  const pricing = factory();
  if (typeof module === 'object' && module.exports) module.exports = pricing;
  if (root) root.ChinoPricing = pricing;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const field = (court, camel, snake) => court?.[camel] ?? court?.[snake];

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
  }

  function regularTiers(court, fallbackTiers = []) {
    const own = field(court, 'rateSchedule', 'rate_schedule');
    const tiers = Array.isArray(own) && own.length ? own : fallbackTiers;
    return (Array.isArray(tiers) ? tiers : []).map(tier => ({
      from: Number(tier.from), to: Number(tier.to), rate: Number(tier.rate),
    })).filter(tier => Number.isFinite(tier.from) && Number.isFinite(tier.to)
      && Number.isFinite(tier.rate) && tier.rate >= 0);
  }

  function regularRateForHour(court, hour, fallbackTiers = []) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return 0;
    const tiers = regularTiers(court, fallbackTiers);
    for (const tier of tiers) {
      if (tier.from < tier.to ? h >= tier.from && h < tier.to : h >= tier.from || h < tier.to) {
        return money(tier.rate);
      }
    }
    // Existing court pricing uses the cheapest tier for gaps in a schedule.
    const rate = tiers.length ? Math.min(...tiers.map(tier => tier.rate)) : Number(court?.rate);
    return Number.isFinite(rate) ? money(Math.max(0, rate)) : 0;
  }

  function promoForDate(court, date) {
    const enabled = field(court, 'promoEnabled', 'promo_enabled') === true;
    const rawRate = field(court, 'promoRate', 'promo_rate');
    const amount = rawRate === null || rawRate === undefined || rawRate === '' ? NaN : Number(rawRate);
    const startsOn = field(court, 'promoStartDate', 'promo_start_date') || null;
    const endsOn = field(court, 'promoEndDate', 'promo_end_date') || null;
    const state = { active: false, rate: Number.isFinite(amount) ? money(amount) : null, status: 'off', startsOn, endsOn };
    if (!enabled) return state;
    if (!validDate(date) || !Number.isFinite(amount) || amount <= 0
      || (startsOn && !validDate(startsOn)) || (endsOn && !validDate(endsOn))
      || (startsOn && endsOn && startsOn > endsOn)) {
      return { ...state, status: 'invalid' };
    }
    if (startsOn && date < startsOn) return { ...state, status: 'scheduled' };
    if (endsOn && date > endsOn) return { ...state, status: 'expired' };
    return { ...state, active: true, status: 'active' };
  }

  function rateForHour(court, hour, date, fallbackTiers = []) {
    const regular = regularRateForHour(court, hour, fallbackTiers);
    const promo = promoForDate(court, date);
    // The database also caps a promo at the regular rate if settings later change.
    return promo.active ? Math.min(regular, promo.rate) : regular;
  }

  function validatePromo(court, fallbackTiers = []) {
    if (field(court, 'promoEnabled', 'promo_enabled') !== true) return '';
    const raw = field(court, 'promoRate', 'promo_rate');
    const rate = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(rate) || rate <= 0) return 'Enter a promo rate greater than ₱0.';
    if (Math.abs(rate - money(rate)) > 0.0000001) return 'Use no more than two decimal places for the promo rate.';
    const start = field(court, 'promoStartDate', 'promo_start_date');
    const end = field(court, 'promoEndDate', 'promo_end_date');
    if ((start && !validDate(start)) || (end && !validDate(end))) return 'Choose valid promo start and end dates.';
    if (start && end && start > end) return 'The promo end date must be on or after its start date.';
    const tiers = regularTiers(court, fallbackTiers);
    const minimum = tiers.length ? Math.min(...tiers.map(tier => tier.rate)) : Number(court?.rate);
    if (!Number.isFinite(minimum) || rate >= minimum) return 'Set the promo below the lowest regular hourly rate.';
    return '';
  }

  function bookingQuote(courtAmount, hours, settings = {}) {
    const listed = money(Math.max(0, Number(courtAmount) || 0));
    const units = Math.max(0, Number(hours) || 0);
    const rate = Math.max(0, Number(settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee ?? 0) || 0);
    const separate = settings.booking_fee_mode === 'separate';
    const fee = money(rate * (settings.fee_type === 'flat' && !separate ? 1 : units));
    const serviceFee = separate ? fee : Math.min(listed, fee);
    return { courtFee: separate ? listed : money(listed - serviceFee), serviceFee,
      total: separate ? money(listed + fee) : listed, feeMode: separate ? 'separate' : 'included' };
  }

  function todayInManila(now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  return { bookingQuote, regularRateForHour, rateForHour, promoForDate, validatePromo, todayInManila, validDate };
});
