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

test('premium TV display keeps four now-playing cards above separated schedule panels', () => {
  const css = fs.readFileSync('dashboard-court-activity.css', 'utf8');
  assert.match(source, /id="courtActivityTv"[\s\S]*?id="courtActivityTvBody"/);
  assert.match(source, /class="ca-tv-open"[\s\S]*?>[^<]*<span[^>]*>▣<\/span> TV display/);
  assert.match(source, /ca-tv-now-grid[\s\S]*?snapshot\.courts\.map\(courtActivityTvNowCard\)[\s\S]*?ca-tv-lower[\s\S]*?ca-tv-next[\s\S]*?ca-tv-upcoming/);
  assert.match(css, /\.ca-tv-now-grid\s*\{[^}]*grid-template-columns:repeat\(2/);
  assert.match(css, /\.ca-tv-lower\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.ca-tv-stage\s*\{[^}]*grid-template-rows:minmax\(0,7fr\) minmax\(240px,3fr\)/);
  assert.doesNotMatch(source, /class="ca-tv-court-number"/);
  assert.match(css, /\.ca-tv-court > header\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /\.ca-tv-court h2\s*\{[^}]*font-family:'DM Sans',sans-serif[^}]*text-transform:none/);
  assert.match(css, /\.ca-tv-next h2,\.ca-tv-upcoming h2\s*\{[^}]*font-family:'DM Sans',sans-serif[^}]*text-transform:none/);
  assert.match(source, /ca-tv-brand[^>]*><img src="assets\/chino-logo-transparent\.png"/);
  assert.match(source, /ca-tv-time[\s\S]*?courtActivityTvClock[\s\S]*?courtActivityTvDate[\s\S]*?courtActivityTvTitle">Today’s Court Activity/);
  assert.match(css, /\.ca-tv-next-grid,\.ca-tv-upcoming-list\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(source, /const pageSize = 8/);
  assert.match(css, /\.ca-tv-next-card,\.ca-tv-upcoming-list article\s*\{[^}]*min-height:clamp\(42px,4\.3vh,56px\)/);
});

test('TV display is today-only, privacy-safe, self-updating and closable', () => {
  const renderer = source.slice(source.indexOf('function renderCourtActivityTv()'), source.indexOf('function courtActivityCard('));
  assert.match(renderer, /buildTvSnapshot\(_courtActivityBookings\)/);
  assert.match(renderer, /item\.displayName/);
  assert.doesNotMatch(renderer, /item\.fullName|item\.email|item\.ref/);
  assert.match(renderer, /setInterval\(updateCourtActivityTvClock, 1000\)/);
  assert.match(renderer, /setInterval\(\(\) => \{ _courtActivityTvPage \+= 1; renderCourtActivityTv\(\); \}, 12000\)/);
  assert.match(source, /event\.key === 'Escape'[\s\S]*?closeCourtActivityTv\(\)/);
  assert.match(source, /fullscreenchange[\s\S]*?closeCourtActivityTv\(\)/);
});
