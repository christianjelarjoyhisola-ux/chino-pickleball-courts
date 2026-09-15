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
  assert.match(source, /ca-tv-brand[^>]*>\s*<img src="assets\/chino-logo-transparent\.png"/);
  assert.match(source, /courtActivityTvVenueName">CHINO Pickleball Courts<[\s\S]*?courtActivityTvVenueAddress">Prk\. Bautista, Mankilam, Tagum City</);
  assert.match(source, /DB\.getSettings\(\)\.then\(settings =>[\s\S]*?settings\?\.venue_name[\s\S]*?settings\?\.venue_address/);
  assert.match(css, /\.ca-tv-brand-copy strong\s*\{[^}]*font-size:clamp\(16px,1\.15vw,22px\)/);
  assert.match(source, /ca-tv-time[\s\S]*?courtActivityTvClock[\s\S]*?courtActivityTvDate[\s\S]*?courtActivityTvTitle">Today’s Court Activity/);
  assert.match(css, /\.ca-tv-next-grid,\.ca-tv-upcoming-list\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.ca-tv-next-grid\s*\{[^}]*grid-template-rows:repeat\(2,minmax\(0,1fr\)\)[^}]*align-content:stretch/);
  assert.match(css, /\.ca-tv-next-card\s*\{[^}]*min-height:0[^}]*padding:clamp\(10px,\.8vw,16px\)/);
  assert.match(source, /const pageSize = 8/);
  assert.match(css, /\.ca-tv-next-card,\.ca-tv-upcoming-list article\s*\{[^}]*min-height:clamp\(42px,4\.3vh,56px\)/);
});

test('TV display is today-only, privacy-safe, self-updating and closable', () => {
  const renderer = source.slice(source.indexOf('function renderCourtActivityTv()'), source.indexOf('function courtActivityCard('));
  assert.match(renderer, /buildTvSnapshot\(_courtActivityBookings, \{ now: courtActivityNow\(\) \}\)/);
  assert.match(source, /const tvOpen = \$\('courtActivityTv'\)[\s\S]*?if \(tvOpen \|\| Date\.now\(\) - _courtActivitySyncedAt >= 60000\) void refreshCourtActivity\(\)/);
  assert.match(renderer, /item\.displayName/);
  assert.doesNotMatch(renderer, /item\.fullName|item\.email|item\.ref/);
  assert.match(renderer, /setInterval\(updateCourtActivityTvClock, 1000\)/);
  assert.match(renderer, /setInterval\(\(\) => \{ if \(!_courtActivityTvPromoActive\) \{ _courtActivityTvPage \+= 1; renderCourtActivityTv\(\); \} \}, 12000\)/);
  assert.match(source, /event\.key === 'Escape'[\s\S]*?closeCourtActivityTv\(\)/);
  assert.match(source, /fullscreenchange[\s\S]*?closeCourtActivityTv\(\)/);
});

test('premium TV promotes authoritative tomorrow slots every five seconds without prices or guests', () => {
  const css = fs.readFileSync('dashboard-court-activity.css', 'utf8');
  const promo = source.slice(source.indexOf('function courtActivityTvPromoPageCount('), source.indexOf('function renderCourtActivityTv()'));
  const lifecycle = source.slice(source.indexOf('function renderCourtActivityTv()'), source.indexOf('function courtActivityCard('));
  assert.match(source, /COURT_ACTIVITY_TV_PROMO_INTERVAL_MS = 5 \* 1000/);
  assert.match(source, /COURT_ACTIVITY_TV_PROMO_DURATION_MS = 20 \* 1000/);
  assert.match(source, /COURT_ACTIVITY_TV_PROMO_PAGE_SIZE = 8/);
  assert.match(promo, /DB\.getAvailabilityGraphic\(date, \[\]\)/, 'authoritative availability RPC is refreshed before display');
  assert.match(promo, /court\.slots\.slice[\s\S]*?slot\.availability === 'booked' \? 'Booked'[\s\S]*?slot\.label/);
  assert.match(promo, /Book your court for tomorrow/);
  assert.match(source, /COURT_ACTIVITY_BOOKING_URL = 'HTTPS:\/\/WWW\.CHINOPICKLEBALLCOURT\.COM'/);
  assert.match(promo, /PaddleRageQRCode\.toCanvas[\s\S]*?width: 132, margin: 4, errorCorrectionLevel: 'M'[\s\S]*?www\.chinopickleballcourt\.com/i);
  assert.doesNotMatch(promo, /price|fullName|displayName|customer|email/i);
  assert.match(lifecycle, /if \(!_courtActivityTvPromoActive\)[\s\S]*?_courtActivityTvPage \+= 1/, 'today paging pauses during the promotion');
  assert.match(lifecycle, /clearInterval\(_courtActivityTvPromoScheduleTimer\)[\s\S]*?clearTimeout\(_courtActivityTvPromoEndTimer\)/, 'closing TV clears every promotion timer');
  assert.match(css, /\.ca-tv-promo-grid\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*grid-template-rows:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.ca-tv-promo-slots\s*\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)[^}]*grid-template-rows:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.ca-tv-promo-slot\.is-booked\s*\{/);
  assert.match(css, /\.ca-tv-promo-hero h2\s*\{[^}]*font-family:'DM Sans',sans-serif[^}]*line-height:1\.08[^}]*text-transform:none/);
  assert.match(css, /\.ca-tv-promo-kicker\s*\{[^}]*font-size:clamp\(15px,1\.05vw,20px\)/);
  assert.match(css, /\.ca-tv-promo-hero p\s*\{[^}]*font-size:clamp\(20px,1\.45vw,28px\)[^}]*font-weight:750/);
  assert.match(promo, /ca-tv-promo-date-line[\s\S]*?snapshot\.dateLabel/);
  assert.match(css, /\.ca-tv-promo-date-line\s*\{[^}]*font-size:clamp\(21px,1\.55vw,30px\)[^}]*font-weight:850/);
  assert.doesNotMatch(promo, /ca-tv-promo-status|Tomorrow’s date/);
  assert.match(css, /\.ca-tv-promo-cta small\s*\{[^}]*font-size:clamp\(16px,1\.25vw,23px\)[^}]*font-weight:850/);
  assert.match(css, /\.ca-tv-promo-footer\s*\{[^}]*min-height:88px/);
  assert.match(css, /\.ca-tv-promo-qr\s*\{[^}]*width:132px[^}]*height:132px[^}]*border:4px solid #fff/);
  assert.match(css, /\.ca-tv-promo-qr canvas\s*\{[^}]*image-rendering:pixelated/);
  assert.match(promo, /ca-tv-promo-qr-wrap[\s\S]*?>Scan to book</);
  assert.match(css, /\.ca-tv-promo-qr-wrap\s*\{[^}]*align-self:center[^}]*justify-self:end/);
  assert.match(css, /\.ca-tv-promo-qr-wrap > span\s*\{[^}]*position:absolute[^}]*bottom:calc\(100% \+ 7px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)[\s\S]*?animation:none/);
});
