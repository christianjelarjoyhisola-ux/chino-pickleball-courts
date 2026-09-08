const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
const adapterSource = source.slice(source.indexOf('function _pbNormalizeCourtPromo('), source.indexOf('function rowToAccount('));
const plain = value => JSON.parse(JSON.stringify(value));
const court = overrides => ({
  id: 'test-court', name: 'Test Court', desc: 'Outdoor', rate: 300, blocked: false,
  feats: ['Outdoor'], photo: 'court.png', rateSchedule: null, promoEnabled: true,
  promoRate: 200, promoStartDate: '2026-09-08', promoEndDate: '2026-09-30', ...overrides,
});

function adapter() {
  const context = vm.createContext({});
  vm.runInContext(adapterSource, context);
  return context;
}

test('court adapters round-trip promo settings and preserve existing court properties', () => {
  const context = adapter();
  const input = court({ promoRate: '199.50', rateSchedule: [{ from: 6, to: 18, rate: 250 }] });
  const row = context.courtToRow(input);
  assert.equal(row.promo_enabled, true);
  assert.equal(row.promo_rate, 199.5);
  const restored = plain(context.rowToCourt(row));
  assert.deepEqual(restored, { ...input, promoRate: 199.5, createdAt: null });
  const disabled = context.courtToRow({ ...restored, promoEnabled: false });
  assert.equal(disabled.promo_enabled, false);
  assert.equal(disabled.promo_rate, 199.5);
  assert.equal(disabled.promo_start_date, '2026-09-08');
  assert.equal(disabled.promo_end_date, '2026-09-30');
});

test('older courts load safely without promo columns and empty disabled fields serialize as null', () => {
  const context = adapter();
  const old = context.rowToCourt({ id: 'old', rate: 300 });
  assert.equal(old.promoEnabled, false);
  for (const key of ['promoRate', 'promoStartDate', 'promoEndDate']) assert.equal(old[key], null);
  const row = context.courtToRow(court({ promoEnabled: false, promoRate: ' ', promoStartDate: '', promoEndDate: null }));
  assert.equal(row.promo_enabled, false);
  for (const key of ['promo_rate', 'promo_start_date', 'promo_end_date']) assert.equal(row[key], null);
});

test('promo rate must be positive and finite; enabled promos must be below the active regular rate', () => {
  const context = adapter();
  for (const enabled of [true, false]) {
    for (const rate of [0, -1, 'bad', Infinity, NaN, true, 12.345]) {
      assert.throws(() => context.courtToRow(court({ promoEnabled: enabled, promoRate: rate })), /Promo hourly rate/);
    }
  }
  for (const rate of [300, 301]) assert.throws(() => context.courtToRow(court({ promoRate: rate })), /Promo hourly rate/);
  assert.equal(context.courtToRow(court({ promoEnabled: false, promoRate: 301 })).promo_rate, 301);
  assert.throws(() => context.courtToRow(court({ promoRate: null })), /Enter a promo hourly rate/);
  assert.throws(() => context.courtToRow(court({ promoEnabled: 'false' })), /true or false/);
  assert.equal(context.courtToRow(court({ promoRate: 299.99 })).promo_rate, 299.99);
});

test('promo compares every court tier and uses global tiers only when the court has none', () => {
  const context = adapter();
  const globalSettings = { pricing_tiers: JSON.stringify([{ from: 6, to: 18, rate: 100 }, { from: 18, to: 24, rate: 400 }]) };
  for (const rateSchedule of [null, []]) {
    assert.throws(() => context.courtToRow(court({ rateSchedule }), globalSettings), /every regular pricing tier/);
    assert.equal(context.courtToRow(court({ rateSchedule, promoRate: 99 }), globalSettings).promo_rate, 99);
  }
  const tiers = [{ from: 6, to: 18, rate: 220 }, { from: 18, to: 24, rate: 180 }];
  assert.throws(() => context.courtToRow(court({ rateSchedule: tiers })), /every regular pricing tier/);
  assert.equal(context.courtToRow(court({ rateSchedule: tiers, promoRate: 170 }), globalSettings).promo_rate, 170);
  assert.equal(context.courtToRow(court({ rate: 150, rateSchedule: [{ from: 0, to: 24, rate: 400 }] })).promo_rate, 200);
  assert.throws(() => context.courtToRow(court(), { pricing_tiers: 'invalid' }), /regular pricing tiers/);
});

test('promo dates accept open bounds, leap days and a single inclusive date', () => {
  const context = adapter();
  for (const dates of [
    { promoStartDate: null, promoEndDate: null },
    { promoStartDate: '2028-02-29', promoEndDate: null },
    { promoStartDate: null, promoEndDate: '2026-09-08' },
    { promoStartDate: '2026-09-08', promoEndDate: '2026-09-08' },
  ]) {
    const row = context.courtToRow(court(dates));
    assert.equal(row.promo_start_date, dates.promoStartDate);
    assert.equal(row.promo_end_date, dates.promoEndDate);
  }
});

test('nonempty invalid dates and reversed date windows reject even when the promo is disabled', () => {
  const context = adapter();
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-09-00', '0000-01-01', '09/08/2026', '2026-09-08T00:00:00Z']) {
    for (const key of ['promoStartDate', 'promoEndDate']) {
      assert.throws(() => context.courtToRow(court({ promoEnabled: false, [key]: invalid })), /valid calendar date/);
    }
  }
  assert.throws(() => context.courtToRow(court({ promoStartDate: '2026-10-01', promoEndDate: '2026-09-30' })), /on or after/);
});

test('remote saves validate global fallback before mutation and clear court cache only after success', async () => {
  const changes = [];
  const cleared = [];
  let error = null;
  const context = vm.createContext({
    console: { error() {} },
    _sb: { from(table) { assert.equal(table, 'courts'); return { async upsert(row) { changes.push(plain(row)); return { error }; } }; } },
    _pbClearFastCache: scopes => cleared.push(plain(scopes)),
  });
  const method = source.match(/  async saveCourt\(court\) \{[\s\S]*?\n  \},/)[0];
  vm.runInContext(`${adapterSource}\nthis.DB = {${method}};`, context);
  context.DB.getSettings = async () => ({ pricing_tiers: '[{"from":0,"to":24,"rate":150}]' });
  await assert.rejects(context.DB.saveCourt(court()), /every regular pricing tier/);
  assert.equal(changes.length, 0);
  await context.DB.saveCourt(court({ promoRate: 100 }));
  assert.equal(changes[0].promo_rate, 100);
  assert.deepEqual(cleared, [['courts']]);
  error = new Error('Court update denied');
  await assert.rejects(context.DB.saveCourt(court({ promoRate: 100 })), /Court update denied/);
  assert.equal(cleared.length, 1);
});

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function localClient() {
  const context = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    location: { hostname: 'localhost', pathname: '/admin.html', search: '?localData=1' },
    localStorage: storage(), sessionStorage: storage(), URLSearchParams, structuredClone,
    supabase: { createClient: () => ({ from() { assert.fail('Local promo save must not reach the server'); } }) },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  context.Auth.getSession = () => ({ role: 'court_owner', status: 'active' });
  return context;
}

test('local saves validate global tiers and retain saved promo and court preferences through updates', async () => {
  const page = localClient();
  await page.DB.saveSetting('pricing_tiers', '[{"from":6,"to":24,"rate":150}]');
  await assert.rejects(page.DB.saveCourt(court()), /every regular pricing tier/);
  assert.equal((await page.DB.getCourts()).some(row => row.id === 'test-court'), false);
  await page.DB.saveCourt(court({ promoRate: 100 }));
  await page.DB.saveCourt({ id: 'test-court', blocked: true });
  const stored = (await page.DB.getCourts()).find(row => row.id === 'test-court');
  assert.equal(stored.blocked, true);
  assert.equal(stored.promoRate, 100);
  assert.equal(stored.promoStartDate, '2026-09-08');
  assert.equal(stored.photo, 'court.png');
  await page.DB.saveCourt({ id: 'test-court', promoEnabled: false });
  const disabled = (await page.DB.getCourts()).find(row => row.id === 'test-court');
  assert.equal(disabled.promoEnabled, false);
  assert.equal(disabled.promoRate, 100);
});

test('local promo writes reject non-owner and inactive sessions without changing saved data', async () => {
  const page = localClient();
  const original = plain(await page.DB.getCourts());
  for (const session of [null, { role: 'staff' }, { role: 'host' }, { role: 'owner', status: 'inactive' }]) {
    page.Auth.getSession = () => session;
    await assert.rejects(page.DB.saveCourt(court()), /Only an active owner/);
    assert.deepEqual(plain(await page.DB.getCourts()), original);
  }
});
