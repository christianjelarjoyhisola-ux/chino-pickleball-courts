const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('admin.html', 'utf8');

function refreshHarness(fetchBookings, initial = null) {
  const implementation = source.slice(source.indexOf('async function refreshCourtActivity()'), source.indexOf("document.getElementById('courtActivityBody')"));
  return new Function('fetchBookings', 'initial', `
    let _courtActivityBookings = initial;
    let _courtActivityRefreshPromise = null;
    let _courtActivityError = false;
    let applied = 0;
    let rendered = 0;
    const nodes = Object.fromEntries(['courtActivityRefresh','courtActivity','courtActivityBody','courtActivityUpdated'].map(id=>[id,{disabled:false,setAttribute(){}}]));
    const $ = id => nodes[id];
    const DB = {getCourtActivityBookings: fetchBookings};
    function setCourtActivityBookings(rows) { _courtActivityBookings = rows; _courtActivityError = false; applied++; }
    function renderCourtActivity() { rendered++; }
    ${implementation}
    return {refresh:refreshCourtActivity,state:()=>({bookings:_courtActivityBookings,error:_courtActivityError,applied,rendered,disabled:nodes.courtActivityRefresh.disabled,message:nodes.courtActivityUpdated.textContent})};
  `)(fetchBookings, initial);
}

test('activity refresh keeps the previous schedule on a read failure', async () => {
  const previous = [{ref:'CONFIRMED-SESSION'}];
  const harness = refreshHarness(async () => { throw new Error('Offline'); }, previous);
  await harness.refresh();
  assert.equal(harness.state().bookings, previous);
  assert.equal(harness.state().error, true);
  assert.equal(harness.state().applied, 0);
  assert.equal(harness.state().rendered, 1);
  assert.equal(harness.state().disabled, false);
});

test('initial activity read failure is explicit and can be retried', async () => {
  let failed = true;
  const harness = refreshHarness(async () => { if (failed) throw new Error('Unavailable'); return []; });
  await harness.refresh();
  assert.equal(harness.state().bookings, null);
  assert.equal(harness.state().message, 'Could not load schedule');
  failed = false;
  await harness.refresh();
  assert.deepEqual(harness.state().bookings, []);
  assert.equal(harness.state().error, false);
});

test('simultaneous activity refreshes share one in-flight read', async () => {
  let resolve, reads = 0;
  const result = new Promise(done => { resolve = done; });
  const harness = refreshHarness(() => { reads++; return result; });
  const first = harness.refresh();
  const second = harness.refresh();
  assert.equal(reads, 1);
  assert.equal(harness.state().disabled, true);
  resolve([{ref:'NEXT'}]);
  await Promise.all([first,second]);
  assert.equal(harness.state().applied, 1);
  assert.equal(harness.state().disabled, false);
});

test('activity cards escape customer names and booking references', () => {
  const escapeSource = source.slice(source.indexOf('function esc(v)'), source.indexOf('function jsArg(v)'));
  const cardSource = source.slice(source.indexOf('function courtActivityCard('), source.indexOf('function renderCourtActivity()'));
  const card = new Function(`${escapeSource}\nconst phDateKeyFromTimestamp=()=> '2026-09-09';\n${cardSource};return courtActivityCard;`)();
  const html = card({ref:'" onclick="alert(1)',fullName:'<img src=x onerror=alert(1)>',courtName:'Court & 1',date:'2026-09-09',startMs:1,endMs:10000000000000,startLabel:'3:00 PM',endLabel:'4:00 PM',minutesUntilStart:30,minutesUntilEnd:90},'next');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes(' onclick="'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('Court &amp; 1'));
  assert.ok(html.includes('data-activity-ref="&quot; onclick=&quot;alert(1)"'));
});
