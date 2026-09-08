const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const page = fs.readFileSync('login.html', 'utf8');

function source(name) {
  const match = page.match(new RegExp('^(?:async )?function ' + name + '\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^\\}', 'm'));
  assert.ok(match, `Missing ${name}`);
  return match[0];
}

function harness(next, ok = true) {
  const origin = 'https://chinopickleball.pages.dev';
  const location = { origin, href:origin + '/login', search:'?next=' + encodeURIComponent(next ?? '') };
  const nodes = {
    uname:{ value:'owner@chino.local' }, upass:{ value:'test-password' }, rememberMe:{ checked:false },
    errBox:{ textContent:'', classList:{ add() {} } },
  };
  const context = vm.createContext({
    URL, URLSearchParams, window:{ location }, document:{ getElementById:id => nodes[id] },
    Auth:{ login:async () => ({ ok, msg:ok ? '' : 'Invalid login' }) },
  });
  vm.runInContext(source('loginReturnDestination') + '\n' + source('doLogin'), context);
  return { context, location, nodes };
}

test('login return destination preserves same-origin dashboard routes and section links', () => {
  const { context } = harness();
  for (const [input, expected] of [
    ['admin.html#bookings', 'https://chinopickleball.pages.dev/admin.html#bookings'],
    ['/admin#courts', 'https://chinopickleball.pages.dev/admin#courts'],
    ['https://chinopickleball.pages.dev/admin?view=payments#pending', 'https://chinopickleball.pages.dev/admin?view=payments#pending'],
    ['https://chinopickleball.pages.dev//other.example/path', 'https://chinopickleball.pages.dev//other.example/path'],
  ]) assert.equal(context.loginReturnDestination(input), expected);
});

test('login return destination rejects external, executable, malformed and credential-bearing URLs', () => {
  const { context } = harness();
  for (const input of [
    null, undefined, '', '   ', 'https://outside.example', '//outside.example', '\\\\outside.example',
    'javascript:alert(1)', 'data:text/html,test', 'http://chinopickleball.pages.dev/admin',
    'https://chinopickleball.pages.dev.outside.example/admin', 'https://chinopickleball.pages.dev@outside.example/admin',
    'https://user:password@chinopickleball.pages.dev/admin', 'https://[invalid', '\n/admin',
  ]) assert.equal(context.loginReturnDestination(input), 'admin.html', String(input));
});

test('successful login uses the safe destination while failed login keeps the user on sign in', async () => {
  for (const [next, expected] of [
    ['//outside.example', 'admin.html'],
    ['admin.html#bookings', 'https://chinopickleball.pages.dev/admin.html#bookings'],
  ]) {
    const { context, location } = harness(next);
    await context.doLogin({ preventDefault() {}, target:{ querySelector:() => ({}) } });
    assert.equal(location.href, expected);
  }
  const { context, location, nodes } = harness('admin.html#bookings', false);
  const button = {};
  await context.doLogin({ preventDefault() {}, target:{ querySelector:() => button } });
  assert.equal(location.href, 'https://chinopickleball.pages.dev/login');
  assert.equal(button.disabled, false);
  assert.equal(nodes.errBox.textContent, 'Invalid login');
});

test('password recovery remains on its form even with a cached session and a consumed auth hash', () => {
  const capture = page.match(/^const loginRecoveryRequested = .*;$/m)?.[0];
  assert.ok(capture);
  assert.ok(page.indexOf(capture) < page.indexOf('<script src="supabase-config.js'));
  for (const recovery of [true, false]) {
    const loginPanel = { style:{} };
    const shown = new Set();
    const location = { href:'https://chinopickleball.pages.dev/login', search:'', hash:recovery ? '#access_token=test&type=recovery' : '' };
    const context = vm.createContext({
      URLSearchParams, window:{ location }, Auth:{ getSession:() => ({ role:'owner' }) },
      document:{ getElementById:id => id === 'loginPanel' ? loginPanel : { classList:{ add:name => shown.add(name) } } },
    });
    vm.runInContext(capture + '\n' + source('handleLoginEntry'), context);
    location.hash = '';
    context.handleLoginEntry();
    if (recovery) {
      assert.equal(location.href, 'https://chinopickleball.pages.dev/login');
      assert.equal(loginPanel.style.display, 'none');
      assert.equal(shown.has('show'), true);
    } else {
      assert.equal(location.href, 'admin.html');
    }
  }
});
