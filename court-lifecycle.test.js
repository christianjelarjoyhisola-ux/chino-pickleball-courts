const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const clientSource = read('supabase-config.js');
const adminSource = read('admin.html');

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function backend(options = {}) {
  const state = {
    rows: [],
    readError: null,
    deleteError: null,
    denyDelete: false,
    reads: 0,
    mutations: [],
    ...options,
  };
  return {
    state,
    from(table) {
      assert.equal(table, 'courts', 'court lifecycle must not write unrelated tables');
      let operation = 'read';
      let id;
      let selected = '*';
      let input;
      const query = {
        select(columns) { selected = columns; return query; },
        order() { return query; },
        eq(column, value) { assert.equal(column, 'id'); id = value; return query; },
        delete() { operation = 'delete'; return query; },
        insert(rows) { operation = 'insert'; input = rows; return query; },
        upsert(rows) { operation = 'upsert'; input = rows; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (operation === 'read') {
              state.reads += 1;
              return { data: state.readError ? null : structuredClone(state.rows), error: state.readError };
            }
            state.mutations.push({ operation, id, input });
            if (operation === 'delete') {
              if (state.deleteError) return { data: null, error: state.deleteError };
              if (state.denyDelete) return { data: [], error: null };
              const deleted = state.rows.filter(row => row.id === id);
              state.rows = state.rows.filter(row => row.id !== id);
              return {
                data: selected === 'id' ? deleted.map(row => ({ id: row.id })) : null,
                error: null,
              };
            }
            state.rows.push(...(Array.isArray(input) ? input : [input]));
            return { data: null, error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function loadClient({ db = backend(), local = false, localStorage = storage() } = {}) {
  const context = {
    console: { error() {}, info() {}, warn() {}, log() {} },
    location: {
      hostname: local ? 'localhost' : 'paddlerage.example',
      pathname: '/admin.html',
      search: local ? '?localData=1' : '',
    },
    localStorage,
    sessionStorage: storage(),
    URLSearchParams,
    structuredClone,
    supabase: { createClient: () => db },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(clientSource, context, { filename: 'supabase-config.js' });
  return context;
}

function loadAdmin(db, confirmed = true) {
  const source = adminSource.match(/async function delCourt\(id\)\{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(source, 'admin court deletion handler must exist');
  const events = [];
  const context = vm.createContext({
    DB: db,
    confirm: () => confirmed,
    console: { error() {} },
    renderCourts: async () => { events.push({ type: 'render' }); },
    toast: (message, severity) => { events.push({ type: 'toast', message, severity }); },
  });
  vm.runInContext(source, context);
  return { deleteCourt: id => context.delCourt(id), events };
}

test('repeated production loads never recreate deleted courts after empty or failed reads', async () => {
  for (const readError of [null, { message: 'Court read denied', code: '42501' }]) {
    const db = backend({ readError });
    for (let reload = 0; reload < 3; reload += 1) {
      const page = loadClient({ db });
      await page.DB.getCourts();
      await page.DB.seedDefaultData();
    }
    assert.equal(db.state.reads, 3);
    assert.deepEqual(db.state.rows, []);
    assert.deepEqual(db.state.mutations, [], 'a read failure or empty result must never cause inserts');
  }
  assert.doesNotMatch(read('index.html'), /\bDB\.seedDefaultData\s*\(/,
    'public page startup must not seed production courts');
});

test('database errors and RLS zero-row deletions propagate without admin success', async () => {
  const failures = [
    { deleteError: { message: 'Permission denied', code: '42501' } },
    { deleteError: { message: 'Court still has related records', code: '23503' } },
    { denyDelete: true },
  ];
  for (const failure of failures) {
    const db = backend({ rows: [{ id: 'alpha', name: 'Court Alpha', rate: 300 }], ...failure });
    const page = loadClient({ db });
    const expected = failure.deleteError?.message || 'Court deletion was not confirmed';
    await assert.rejects(page.DB.deleteCourt('alpha'), error => error.message.includes(expected));

    const admin = loadAdmin(page.DB);
    await admin.deleteCourt('alpha');
    assert.equal(db.state.rows.length, 1);
    assert.equal(admin.events.length, 1, 'failed deletion must not render a success state');
    assert.equal(admin.events[0].severity, 'err');
    assert.ok(admin.events[0].message.includes(expected));
  }
});

test('confirmed deletion invalidates cached courts and remains deleted through fresh page loads', async () => {
  const db = backend({ rows: [
    { id: 'alpha', name: 'Court Alpha', rate: 300 },
    { id: 'beta', name: 'Court Beta', rate: 300 },
    { id: 'real', name: 'Actual Court', rate: 300 },
  ] });
  const page = loadClient({ db });
  assert.equal((await page.DB.getCourts()).length, 3);
  assert.equal((await page.DB.getCourts()).length, 3);
  assert.equal(db.state.reads, 1, 'the initial court list is cached');

  for (const id of ['alpha', 'beta']) {
    await page.DB.deleteCourt(id);
    const courts = await page.DB.getCourts();
    assert.equal(courts.some(court => court.id === id), false);
  }
  assert.equal(db.state.reads, 3, 'each confirmed deletion must refresh the court cache');

  for (let reload = 0; reload < 3; reload += 1) {
    const reloaded = loadClient({ db });
    await reloaded.DB.seedDefaultData();
    assert.deepEqual(Array.from(await reloaded.DB.getCourts(), court => court.id), ['real']);
  }
  assert.deepEqual(db.state.mutations.map(change => change.operation), ['delete', 'delete']);
});

test('admin reports success only after deletion resolves and the courts rerender', async () => {
  let resolveDelete;
  const calls = [];
  const admin = loadAdmin({
    deleteCourt: id => {
      calls.push(id);
      return new Promise(resolve => { resolveDelete = resolve; });
    },
  });
  const deletion = admin.deleteCourt('alpha');
  assert.deepEqual(calls, ['alpha']);
  assert.deepEqual(admin.events, []);
  resolveDelete();
  await deletion;
  assert.deepEqual(admin.events, [
    { type: 'render' },
    { type: 'toast', message: 'Court deleted.', severity: 'inf' },
  ]);

  const cancelled = loadAdmin({ deleteCourt() { assert.fail('cancelled deletion must not write'); } }, false);
  await cancelled.deleteCourt('alpha');
  assert.deepEqual(cancelled.events, []);
});

test('deleting every local demo court preserves an empty list after fresh local-mode loads', async () => {
  const localStorage = storage();
  const db = backend();
  const page = loadClient({ db, local: true, localStorage });
  const courts = await page.DB.getCourts();
  assert.ok(courts.length > 0, 'a fresh local database starts with demo courts');
  for (const court of courts) await page.DB.deleteCourt(court.id);
  assert.equal((await page.DB.getCourts()).length, 0);

  for (let reload = 0; reload < 3; reload += 1) {
    const reloaded = loadClient({ db, local: true, localStorage });
    await reloaded.DB.seedDefaultData();
    assert.equal((await reloaded.DB.getCourts()).length, 0);
  }
  assert.deepEqual(JSON.parse(localStorage.getItem('chino_local_db_v1')).courts, []);
  assert.deepEqual(db.state.mutations, [], 'local court deletion must not write to Supabase');
});

test('production setup scripts cannot reinsert sample courts on rerun', () => {
  for (const file of ['SETUP_NEW_SUPABASE.sql', 'setup-db.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /insert\s+into\s+(?:public\.)?courts\b/i, file);
    assert.doesNotMatch(source, /\.from\(['"]courts['"]\)\s*\.(?:insert|upsert)\s*\(/i, file);
  }
});

test('CHINO deployment stays on its own backend and ships only its own venue imagery', () => {
  const config = read('supabase-config.js');
  assert.match(config, /const SUPABASE_URL = 'https:\/\/wskzptxekldhsxluhgos\.supabase\.co'/);
  assert.match(config, /const STORE_KEY = 'chino_local_db_v1'/);
  assert.match(config, /const PB_DATA_MODE_KEY = 'chino_data_mode'/);
  assert.match(config, /const PB_BOOKING_ACCESS_TOKENS_KEY = 'chino_booking_access_tokens_v1'/);

  const deploy = read('deploy-cloudflare-pages.ps1');
  const files = deploy.match(/\$publicFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(files, 'deployment must declare its public file allowlist');
  const deployedFiles = [...files.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  for (const asset of ['assets/chino-mark.svg', 'assets/chino-wordmark.svg', 'assets/chino-courts.png']) {
    assert.ok(deployedFiles.includes(asset), `${asset} must be deployed`);
  }
  const originalTargets = /paddleragecdo\.ph|paddle-rage-pickleball\.pages\.dev|qhvrowoqeyeypmefwkha|paddlerage(?:logo|qrgcash)|paddle-rage-(?:word|grunge|lightning)/i;
  for (const file of deployedFiles) {
    assert.doesNotMatch(file, originalTargets, `original venue asset must not deploy: ${file}`);
    if (/\.(?:html|js|css|svg)$/.test(file)) {
      assert.doesNotMatch(read(file), originalTargets, `${file} must not use original production targets or imagery`);
    }
  }
});

test('fresh CHINO initialization requires an empty venue and unconfigured merchant methods', () => {
  const sql = read('supabase/migrations/20260908120000_chino_independent_venue.sql');
  for (const table of ['courts', 'bookings', 'accounts', 'agreements']) {
    assert.match(sql, new RegExp(`exists \\(select 1 from public\\.${table}\\)`));
  }
  assert.match(sql, /raise exception 'CHINO initialization requires a fresh database/);
  for (const method of ['cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb']) {
    assert.match(sql, new RegExp(`\\('payment_method_${method}', '0', now\\(\\)\\)`));
  }
  for (const setting of ['gcash_merchant_number', 'gcash_merchant_name', 'gcash_qr_image', 'gcash_qr_receipt_destination_token', 'venue_address', 'venue_contact', 'venue_email']) {
    assert.match(sql, new RegExp(`\\('${setting}', '', now\\(\\)\\)`));
  }
  assert.doesNotMatch(sql, /insert\s+into\s+public\.(?:courts|bookings|accounts)\b/i);
});

test('maintenance jobs use protected CHINO project routing and skip unconfigured destinations', () => {
  const baseline = read('SETUP_NEW_SUPABASE.sql');
  assert.match(baseline, /alter table public\.chino_backend_config enable row level security/i);
  assert.match(baseline, /revoke all on public\.chino_backend_config from public, anon, authenticated/i);
  assert.match(baseline, /grant all on public\.chino_backend_config to service_role/i);
  assert.match(baseline, /revoke all on function public\.chino_project_url\(\) from public, anon, authenticated/i);
  assert.match(baseline, /grant execute on function public\.chino_project_url\(\) to service_role/i);
  assert.match(baseline, /project_url text not null check/);
  for (const file of ['20260716120000_host_balance_deadlines.sql', '20260719090000_balance_cron_auth.sql']) {
    const sql = read(`supabase/migrations/${file}`);
    assert.match(sql, /url := public\.chino_project_url\(\) \|\| '\/functions\/v1\/process-host-balance-deadlines'/);
    assert.match(sql, /where public\.chino_project_url\(\) is not null/i);
    assert.doesNotMatch(sql, /https:\/\/[a-z0-9]{20}\.supabase\.co/i);
  }
});

test('venue settings load and save owner-supplied details while rejecting unauthorized or invalid writes', async () => {
  const start = adminSource.indexOf('async function renderVenueDetailsSettings()');
  const end = adminSource.indexOf('async function renderMaintRateSettings(', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {} });
    return elements.get(id);
  };
  const writes = [];
  const notices = [];
  const settings = { venue_address: 'CHINO Court Road', venue_contact: '+63 917 123 4567', venue_email: 'booking@example.com', venue_description: 'Outdoor courts' };
  const context = vm.createContext({
    $: get,
    sess: { role: 'court_owner' },
    Auth: { can: (permission, role) => permission === 'settings' && ['owner', 'court_owner'].includes(role) },
    DB: { getSettings: async () => settings, saveSetting: async (key, value) => writes.push([key, value]) },
    toast: (message, level) => notices.push({ message, level }),
  });
  vm.runInContext(adminSource.slice(start, end), context);
  await context.renderVenueDetailsSettings();
  assert.equal(get('venueAddressInput').value, settings.venue_address);
  assert.equal(get('venueEmailInput').value, settings.venue_email);
  await context.saveVenueDetails();
  assert.deepEqual(Object.fromEntries(writes), settings);
  assert.equal(get('saveVenueDetailsButton').disabled, false);
  writes.length = 0;
  context.sess.role = 'staff';
  await context.saveVenueDetails();
  assert.equal(writes.length, 0);
  context.sess.role = 'owner';
  get('venueContactInput').value = '-------';
  await context.saveVenueDetails();
  assert.equal(writes.length, 0);
  get('venueContactInput').value = '';
  get('venueEmailInput').value = 'invalid email';
  await context.saveVenueDetails();
  assert.equal(writes.length, 0);
  assert.ok(notices.some(notice => notice.level === 'err'));
});

test('public venue footer renders text safely and removes cleared or invalid contact links', () => {
  const page = read('index.html');
  const start = page.indexOf('function applyVenueDetails(settings = {})');
  const end = page.indexOf('function applyPaymentSettings(settings)', start);
  assert.ok(start >= 0 && end > start);
  assert.match(page, /const settings = await DB\.getSettings\(\);\s*applyVenueDetails\(settings\);/);
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', hidden: false,
      removeAttribute(name) { delete this[name]; },
      set innerHTML(_) { assert.fail('venue values must never be interpreted as HTML'); },
    });
    return elements.get(id);
  };
  const context = vm.createContext({ $: get });
  vm.runInContext(page.slice(start, end), context);
  context.applyVenueDetails({
    venue_address: '<img src=x onerror=alert(1)>',
    venue_description: '<script>example</script>',
    venue_contact: '+63 917 123 4567', venue_email: 'booking@example.com',
  });
  assert.equal(get('venueAddress').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(get('venueDescription').textContent, '<script>example</script>');
  assert.equal(get('venuePhoneLink').href, 'tel:+639171234567');
  assert.equal(get('venueEmailLink').href, 'mailto:booking%40example.com');
  assert.equal(get('venuePhoneRow').hidden, false);
  context.applyVenueDetails({ venue_contact: 'javascript:alert(1)', venue_email: '<a>@example.com' });
  assert.equal(get('venueAddress').hidden, true);
  assert.equal(get('venuePhoneRow').hidden, true);
  assert.equal(get('venueEmailRow').hidden, true);
  assert.equal(get('venuePhoneLink').href, undefined);
  assert.equal(get('venueEmailLink').href, undefined);
  assert.match(get('venueContactNote').textContent, /will be published here/);
});
