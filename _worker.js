// This is the existing public anonymous key, never a service-role credential.
const PUBLIC_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indza3pwdHhla2xkaHN4bHVoZ29zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NDA3NDEsImV4cCI6MjEwNDQxNjc0MX0.hW0ApbdEUbhFkLIG_Z32o6uwpYQ_nMcb0sME9vh1kqA';
const PUBLIC_READ_PATHS = new Map([
  ['/rest/v1/courts', 'select=*&order=id.asc'],
  ['/rest/v1/settings', 'select=*'],
  ['/rest/v1/blocked_dates', 'select=date&order=date.asc'],
  ['/rest/v1/rpc/get_public_booking_availability', null],
  ['/rest/v1/rpc/get_public_open_play_counts', null],
  ['/rest/v1/rpc/get_public_weather_closures', ''],
]);

async function servePublicData(request, url) {
  const path = url.pathname.slice('/api/public-data'.length);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (request.method !== 'GET' || !PUBLIC_READ_PATHS.has(path)) {
    return new Response(JSON.stringify({ message: 'Public read not allowed' }), { status: 404, headers });
  }
  const upstream = new URL('https://wskzptxekldhsxluhgos.supabase.co' + path);
  const fixedQuery = PUBLIC_READ_PATHS.get(path);
  if (fixedQuery !== null) upstream.search = fixedQuery;
  else {
    const date = url.searchParams.get('p_date');
    const court = url.searchParams.get('p_court_id');
    if ((date && date !== 'null' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) || (court && court.length > 100)) {
      return new Response(JSON.stringify({ message: 'Invalid availability parameters' }), { status: 400, headers });
    }
    if (date && date !== 'null') upstream.searchParams.set('p_date', date);
    if (court && court !== 'null') upstream.searchParams.set('p_court_id', court);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(upstream.toString(), {
      headers: { apikey: PUBLIC_ANON_KEY, Authorization: 'Bearer ' + PUBLIC_ANON_KEY },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response(JSON.stringify({ message: 'Unexpected database redirect' }), { status: 502, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.error('Public court data unavailable', path, error.name, error.message);
    return new Response(JSON.stringify({ message: 'Court data temporarily unavailable' }), { status: 503, headers });
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/public-data/')) return servePublicData(request, url);

    const primaryHostname = String(env.PRIMARY_HOSTNAME || 'chinopickleballcourt.com').trim().toLowerCase();
    if (primaryHostname && url.hostname === `www.${primaryHostname}`) {
      url.hostname = primaryHostname;
      return Response.redirect(url.toString(), 301);
    }

    if (['/manage', '/manage/'].includes(url.pathname)) {
      url.pathname = '/login';
      return Response.redirect(url.toString(), 302);
    }

    // Cloudflare Pages resolves extensionless HTML routes through the asset
    // binding. Redirecting /host to /host.html here conflicts with Pages'
    // canonical /host.html -> /host redirect and creates a redirect loop.
    const response = await env.ASSETS.fetch(request);
    const releaseCoupledRuntime = new Set([
      '/booking-balance.js',
      '/host-balance-payment.js',
      '/host-balance-admin.js',
      '/owner-insights.js',
      '/owner-insights.css',
      '/weather.css',
      '/weather-api.js',
      '/weather-admin.js',
      '/weather-reschedule.js',
      '/manage-booking.js',
      '/manage-booking.css',
      '/promo-pricing.css',
    ]);
    const isSharedRuntime = url.pathname === '/supabase-config.js' ||
      releaseCoupledRuntime.has(url.pathname);
    const isHtmlEntry = url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      ['/admin', '/host', '/login', '/manage-booking', '/weather-reschedule', '/player-live'].includes(url.pathname);
    if (!isSharedRuntime && !isHtmlEntry) return response;

    // Pages' advanced-mode asset binding can attach a four-hour cache policy
    // even when _headers asks for revalidation. Keep HTML and its shared DB
    // adapter in the same release so a newly deployed UI never calls an older
    // runtime API from the browser cache. Host balance UI, adapter, deadline
    // rules, and review controls are one release-coupled runtime set.
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store, max-age=0');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
