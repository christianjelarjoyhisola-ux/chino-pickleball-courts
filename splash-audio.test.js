const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const page = fs.readFileSync('index.html', 'utf8');
const brandTheme = fs.readFileSync('brand-theme.css', 'utf8');
const mapUrl = 'https://maps.app.goo.gl/7Su6CtSH7HCbpn1K6';
const defaultAddress = 'Prk. Bautista, Mankilam, Tagum City';

function functionSource(name) {
  const match = page.match(new RegExp('^function ' + name + '\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^\\}', 'm'));
  assert.ok(match, 'index.html must define ' + name);
  return match[0];
}

function createHarness({ missingSplash = false } = {}) {
  const classes = new Set();
  const transitions = [];
  const timers = [];
  const scrolls = [];
  const focusCalls = [];
  const splash = {
    style: {},
    classList: { contains: name => classes.has(name), add: name => classes.add(name) },
    addEventListener: (...args) => transitions.push(args),
  };
  const body = { style: { overflow: 'hidden' } };
  const context = vm.createContext({
    document: {
      body,
      getElementById(id) {
        if (id === 'splashScreen') return missingSplash ? null : splash;
        if (id === 'courts') return { scrollIntoView: options => scrolls.push(options) };
        if (id === 'courtSharedDateDisplay') return { focus: options => focusCalls.push(options) };
        return null;
      },
    },
    window: { setTimeout: (callback, delay) => timers.push({ callback, delay }) },
  });
  vm.runInContext(['dismissSplash', 'dismissSplashAndBook', 'handleSplashBackgroundTap'].map(functionSource).join('\n'), context);
  return { context, classes, splash, body, transitions, timers, scrolls, focusCalls };
}

test('the welcome screen has no audio playback, music controls, or beat animation machinery', () => {
  assert.doesNotMatch(page, /<audio\b|new\s+Audio\s*\(|AudioContext|splashWelcomeMusic|splash-music\.mp3|splashSoundToggle|splashAudio|SplashSound|SplashMusic|RageBeat|pr-splash-sound|autoplay/i);
  assert.doesNotMatch(brandTheme, /pr-splash-sound|rage-beat|splash-beat|beat-pulse/i);
});

test('dismissing the splash restores page scrolling and is safe to repeat', () => {
  const harness = createHarness();
  harness.context.dismissSplash();
  assert.equal(harness.classes.has('dismissed'), true);
  assert.equal(harness.body.style.overflow, '');
  assert.equal(harness.transitions.length, 1);
  const [event, complete, options] = harness.transitions[0];
  assert.equal(event, 'transitionend');
  assert.equal(options.once, true);
  complete();
  assert.equal(harness.splash.style.display, 'none');
  harness.context.dismissSplash();
  assert.equal(harness.transitions.length, 1);
  assert.doesNotThrow(() => createHarness({ missingSplash: true }).context.dismissSplash());
});

test('Tap to book dismisses the splash and moves focus to court booking', () => {
  const button = page.match(/<button\b[^>]*class="pr-splash-enter"[^>]*>/);
  assert.ok(button, 'the booking entry must remain a native button');
  const handler = button[0].match(/onclick="([^"]+)"/);
  assert.ok(handler);
  const harness = createHarness();
  let propagationStopped = false;
  harness.context.event = { stopPropagation: () => { propagationStopped = true; } };
  vm.runInContext(handler[1], harness.context);
  assert.equal(propagationStopped, true);
  assert.equal(harness.classes.has('dismissed'), true);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.scrolls.length, 0);
  harness.timers[0].callback();
  assert.equal(harness.scrolls.length, 1);
  assert.equal(harness.scrolls[0].block, 'start');
  assert.equal(harness.focusCalls.length, 1);
  assert.equal(harness.focusCalls[0].preventScroll, true);
  assert.doesNotMatch(page, /advanceBookingNotice|September bookings are open|View September Time Slots/i);
});

test('background taps enter booking while links and buttons keep their own action', () => {
  for (const tagName of ['A', 'BUTTON']) {
    const harness = createHarness();
    harness.context.handleSplashBackgroundTap({ target: { closest: () => ({ tagName }) } });
    assert.equal(harness.classes.has('dismissed'), false, tagName + ' clicks must not dismiss the splash');
    assert.equal(harness.timers.length, 0);
  }
  const harness = createHarness();
  harness.context.handleSplashBackgroundTap({ target: { closest: () => null } });
  assert.equal(harness.classes.has('dismissed'), true);
  assert.equal(harness.timers.length, 1);
});

test('splash and footer addresses open the approved map without dismissing the splash', () => {
  for (const id of ['chinoSplashAddress', 'venueAddress']) {
    const anchor = page.match(new RegExp('<a\\b[^>]*id="' + id + '"[^>]*>[\\s\\S]*?<\\/a>'));
    assert.ok(anchor, id + ' must be a native link');
    const attribute = name => anchor[0].match(new RegExp('\\b' + name + '="([^"]*)"'))?.[1];
    assert.equal(attribute('href'), mapUrl);
    assert.equal(attribute('target'), '_blank');
    assert.deepEqual(attribute('rel').split(/\s+/).sort(), ['noopener', 'noreferrer']);
    assert.ok(anchor[0].includes('<span id="' + id + 'Text">' + defaultAddress + '</span>'), 'the confirmed address is visible before settings load');

    const harness = createHarness();
    let propagationStopped = false;
    let defaultPrevented = false;
    harness.context.event = {
      stopPropagation: () => { propagationStopped = true; },
      preventDefault: () => { defaultPrevented = true; },
    };
    assert.ok(attribute('onclick'), 'map links must stop the splash click from bubbling');
    vm.runInContext(attribute('onclick'), harness.context);
    assert.equal(propagationStopped, true);
    assert.equal(defaultPrevented, false, 'the browser must be allowed to open the map');
    assert.equal(harness.classes.has('dismissed'), false);
    assert.equal(harness.timers.length, 0);
  }
});
