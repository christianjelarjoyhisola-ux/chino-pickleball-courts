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
  assert.deepEqual(JSON.parse(localStorage.getItem('paddle_rage_local_db_v1')).courts, []);
  assert.deepEqual(db.state.mutations, [], 'local court deletion must not write to Supabase');
});

test('production setup scripts cannot reinsert sample courts on rerun', () => {
  for (const file of ['SETUP_NEW_SUPABASE.sql', 'setup-db.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /insert\s+into\s+(?:public\.)?courts\b/i, file);
    assert.doesNotMatch(source, /\.from\(['"]courts['"]\)\s*\.(?:insert|upsert)\s*\(/i, file);
  }
});
