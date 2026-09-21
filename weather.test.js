const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { affected, rules, key, hour, escape } = require('./weather-api.js');

test('closures find each overlapping reservation once and preserve unselected courts', () => {
  const bookings = [{ ref: 'A', courtId: '1', slots: ['9', '10'] }, { ref: 'B', courtId: '2', slots: ['9'] }, { ref: 'C', courtId: '1', slots: [12] }];
  assert.deepEqual(affected(bookings, [{ courtId: '1', hour: 9 }, { courtId: '1', hour: 10 }]).map(b => b.ref), ['A']);
  assert.deepEqual(affected(bookings, []), []);
});
test('weather rules preserve court/date scope and midnight boundary', () => {
  assert.deepEqual(rules([{ courtId: 'court|1', date: '2026-09-23', hour: 23, reason: 'wet_court' }]), [{ enabled: true, mode: 'specific', dates: ['2026-09-23'], courtIds: ['court|1'], start: 23, end: 24, label: 'wet_court', weatherClosure: true }]);
  assert.notEqual(key('1|2', 3), key('1', 23));
  assert.equal(hour(24), '12am');
  assert.equal(hour(12), '12pm');
});
test('player-controlled labels are escaped', () => {
  assert.equal(escape('<img src="x" onerror=\'bad\'>&'), '&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt;&amp;');
});
test('modified HTML scripts parse without syntax errors', () => {
  for (const file of ['admin.html', 'index.html', 'weather-reschedule.html']) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc=|application\/ld\+json/.test(match[1]) && match[2].trim()) new vm.Script(match[2], { filename: file });
    }
  }
});
