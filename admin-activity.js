(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChinoAdminActivity = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const CATEGORIES = ['bookings', 'payments', 'courts', 'finance', 'settings', 'maintenance', 'accounts', 'open_play', 'hosts', 'access', 'navigation', 'interaction', 'export', 'other'];
  const SECTIONS = { dash: 'Dashboard', insights: 'Insights', bookings: 'Bookings', deleted: 'Deleted bookings', activity: 'Activity history', payreview: 'Payment review', reports: 'Reports', courts: 'Courts', gamemgr: 'Play manager', accounts: 'Host accounts', remittances: 'Remittances', hosts: 'Host center', maintenance: 'Maintenance', payments: 'Payments' };
  const PLAY_ACTIONS = new Set(['add-player', 'choose-players', 'continue-live', 'copy-live-link', 'copy-text-update', 'correct-winner', 'disable-live-link', 'display', 'download-result', 'edit-player-skill', 'edit-setup', 'end-session', 'export', 'import-paid', 'native-share-live', 'new-session', 'replace-player', 'rotate-live-link', 'sample-roster', 'share-live', 'skip-player', 'start-match', 'winner']);
  const PLAY_FORMS = new Set(['add-player', 'choose-players', 'correct-winner', 'replace-player', 'setup']);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const words = value => String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  const roleLabel = value => ({ owner: 'System Owner', court_owner: 'Court Owner', staff: 'Court Staff', host: 'Host' }[value] || words(value) || 'System');
  function notificationActivity(item) {
    const details = item.details || {};
    const client = item.source === 'client_reported' && item.action === 'dispatchBookingRescheduleNotifications';
    const server = ['server_reported', 'server_event'].includes(item.source) &&
      (details.endpoint === 'booking-reschedule-notifications' ||
        (item.targetType === 'edge_function' && item.targetId === 'booking-reschedule-notifications'));
    return client || server ? { client, retry: server && (details.action || item.action) === 'retry' } : null;
  }
  function activityTitle(item) {
    const notification = notificationActivity(item);
    if (notification) {
      if (notification.retry) return 'Requested another attempt to send booking-change messages';
      if (item.outcome === 'skipped') return 'Checked for booking-change messages';
      if (item.outcome === 'success') return 'Booking-change message request succeeded';
      if (item.outcome === 'failed') return 'Booking-change message request failed';
      if (item.outcome === 'denied') return 'Booking-change message request denied';
      return 'Started a booking-change message check';
    }
    if (item.action === 'page_view' && SECTIONS[item.targetId]) return `Viewed ${SECTIONS[item.targetId]}`;
    if (['server_reported', 'server_event'].includes(item.source) && item.details?.event === 'edge_request') return 'Service request';
    return words(item.summary || item.action) || 'Activity';
  }
  function activityTarget(item) {
    if (notificationActivity(item)) return 'Messages about requests to change a booking date or time';
    return [words(item.targetType), item.targetId].filter(Boolean).join(' · ') || 'Workspace';
  }
  function dateLabel(value, includeTime = true) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return 'Date unavailable';
    return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', ...(includeTime ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : {}) }).format(date);
  }
  function sourceLabel(item) {
    if (item.source === 'database_change') return { label: 'Saved change', kind: 'saved', explanation: 'Recorded from a database change.' };
    if (item.source === 'auth_event') return { label: 'Account event', kind: 'event', explanation: 'Recorded by the authentication service.' };
    const notification = notificationActivity(item);
    const note = notification ? ' These checks can run automatically while the dashboard is open. The account identifies the session used; this record does not establish a manual click or a booking change.' : '';
    if (notification?.client && item.outcome === 'skipped') return { label: 'Nothing to send', kind: 'view', explanation: 'The browser reported that no booking-change messages were ready to send. This is a normal check result.' + note };
    if (item.source === 'server_reported' || item.source === 'server_event') {
      const result = {
        attempted: ['Request started', 'event', 'The server recorded the start of this request. Its result is recorded separately.'],
        attempt: ['Request started', 'event', 'The server recorded the start of this request. Its result is recorded separately.'],
        success: ['Request succeeded', 'event', 'The server returned a successful response. This alone does not confirm that a message was delivered or a booking was changed.'],
        failed: ['Request failed', 'attempt', 'The server recorded a failed request.'],
        denied: ['Access denied', 'attempt', 'The server denied this request.'],
        skipped: ['Skipped', 'view', 'The server reported that this request was skipped.'],
      }[item.outcome];
      return result ? { label: result[0], kind: result[1], explanation: result[2] + note }
        : { label: 'Server event', kind: 'event', explanation: 'Recorded by the server.' + note };
    }
    if (item.outcome === 'view' || item.outcome === 'viewed' || item.action === 'page_view') return { label: 'Viewed', kind: 'view', explanation: 'Reported by the browser. This does not confirm a saved change.' };
    if (item.outcome === 'success') return { label: 'Reported success', kind: 'event', explanation: 'The browser received a successful response. Saved changes have their own database records.' + note };
    if (item.outcome === 'failed') return { label: 'Reported failure', kind: 'attempt', explanation: 'The browser reported that this request failed.' + note };
    if (item.outcome === 'skipped') return { label: 'Skipped', kind: 'view', explanation: 'The browser reported that this action was skipped. Skipping an action does not by itself mean a failure.' };
    if (item.outcome === 'denied') return { label: 'Reported denial', kind: 'attempt', explanation: 'The browser reported that access to this action was denied.' };
    return { label: 'Attempt', kind: 'attempt', explanation: 'Reported by the browser. A click or request does not confirm that it completed.' };
  }
  const ownSessionKey = (session, canOwner) => session?.id && session.role === 'owner' && (!session.status || session.status === 'active') && canOwner(session) ? String(session.id) + ':owner' : '';

  // Requests retain no data after an account change, even when a previous request finishes late.
  function createStore({ db, getSession, canOwner, onChange = () => {} }) {
    let epoch = 0, detailEpoch = 0, identity = '';
    let state = { items: [], actors: [], nextCursor: null, startedAt: null, capabilities: null, loading: false, error: '', detail: null, detailLoading: false, detailError: '' };
    const emit = () => onChange(state);
    function clear() {
      epoch++; detailEpoch++; identity = '';
      state = { items: [], actors: [], nextCursor: null, startedAt: null, capabilities: null, loading: false, error: '', detail: null, detailLoading: false, detailError: '' };
      emit();
    }
    function authorized() {
      const key = ownSessionKey(getSession(), canOwner);
      if (!key || (identity && key !== identity)) { clear(); return ''; }
      return key;
    }
    async function load(filters = {}, append = false) {
      const key = authorized();
      if (!key) return false;
      identity = key;
      const request = ++epoch;
      detailEpoch++;
      state = { ...state, loading: true, error: '', detail: null, detailLoading: false, detailError: '', ...(append ? {} : { items: [], nextCursor: null }) };
      emit();
      try {
        if (typeof db.getAdminActivity !== 'function') throw new Error('Unavailable');
        const result = await db.getAdminActivity({ ...filters, cursor: append ? state.nextCursor : undefined, limit: 30 });
        if (request !== epoch) return false;
        if (ownSessionKey(getSession(), canOwner) !== key) { clear(); return false; }
        if (!result || !Array.isArray(result.items)) throw new Error('Invalid response');
        const seen = new Set();
        const items = [...(append ? state.items : []), ...result.items].filter(item => item?.id && !seen.has(String(item.id)) && seen.add(String(item.id)));
        state = { ...state, items, actors: Array.isArray(result.actors) ? result.actors : state.actors, startedAt: result.startedAt || state.startedAt, capabilities: result.capabilities || null, nextCursor: result.nextCursor || null, loading: false };
      } catch (_) {
        if (request !== epoch) return false;
        if (ownSessionKey(getSession(), canOwner) !== key) { clear(); return false; }
        state = { ...state, loading: false, error: 'Activity could not be loaded. Please refresh to try again.' };
      }
      emit();
      return !state.error;
    }
    async function detail(id) {
      const key = authorized();
      if (!key || !state.items.some(item => String(item.id) === String(id))) return false;
      const request = ++detailEpoch;
      state = { ...state, detail: null, detailLoading: true, detailError: '' }; emit();
      try {
        const result = await db.getAdminActivityDetail(id);
        if (request !== detailEpoch) return false;
        if (ownSessionKey(getSession(), canOwner) !== key) { clear(); return false; }
        if (!result || String(result.id) !== String(id)) throw new Error('Invalid detail');
        state = { ...state, detail: result, detailLoading: false };
      } catch (_) {
        if (request !== detailEpoch) return false;
        if (ownSessionKey(getSession(), canOwner) !== key) { clear(); return false; }
        state = { ...state, detailLoading: false, detailError: 'Details could not be loaded. Close and try again.' };
      }
      emit(); return !state.detailError;
    }
    function closeDetail() { detailEpoch++; state = { ...state, detail: null, detailLoading: false, detailError: '' }; emit(); }
    return { load, detail, clear, closeDetail, authorized, getState: () => state };
  }

  function itemMarkup(item, index) {
    const source = sourceLabel(item);
    const target = activityTarget(item);
    return `<tr><td data-label="When"><time datetime="${escape(item.occurredAt)}">${escape(dateLabel(item.occurredAt))}</time></td><td data-label="Operator"><strong>${escape(item.actorName || 'System')}</strong><small>${escape(roleLabel(item.actorRole))}</small></td><td data-label="Activity"><strong>${escape(activityTitle(item))}</strong><small>${escape(target)}</small></td><td data-label="Record"><span class="aa-badge aa-${source.kind}">${source.label}</span></td><td><button class="aa-detail-btn" type="button" data-aa-detail="${index}" aria-label="View details for ${escape(activityTitle(item))}">Details <span aria-hidden="true">↗</span></button></td></tr>`;
  }
  function pretty(value) { return value === undefined || value === null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value); }
  function detailMarkup(item) {
    const source = sourceLabel(item);
    const notification = notificationActivity(item);
    const action = notification ? (notification.retry ? 'Retry booking-change messages' : 'Check booking-change messages') : words(item.action) || 'Activity';
    const eventInformation = { ...(item.details || {}), recordedAction: item.action, recordedOutcome: item.outcome };
    const before = item.before && typeof item.before === 'object' ? item.before : {};
    const after = item.after && typeof item.after === 'object' ? item.after : {};
    const changedFields = Array.isArray(item.changedFields) ? item.changedFields.filter(key => typeof key === 'string') : [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after), ...changedFields])].filter(key => changedFields.includes(key) || JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    const changes = keys.map(key => {
      const hidden = /\[REDACTED\]/i.test(pretty(before[key]) + pretty(after[key]));
      return `<section class="aa-change"><h5>${escape(words(key))}</h5>${hidden ? '<p class="aa-detail-note aa-hidden-values">This field changed. Sensitive values are hidden.</p>' : ''}<div><div><span>Before</span><pre>${escape(pretty(before[key]))}</pre></div><div><span>After</span><pre>${escape(pretty(after[key]))}</pre></div></div></section>`;
    }).join('');
    return `<div class="aa-detail-summary"><span class="aa-badge aa-${source.kind}">${source.label}</span><h3>${escape(activityTitle(item))}</h3><p>${escape(source.explanation)}</p><dl><div><dt>Operator</dt><dd>${escape(item.actorName || 'System')} · ${escape(roleLabel(item.actorRole))}</dd></div><div><dt>Philippine time</dt><dd>${escape(dateLabel(item.occurredAt))}</dd></div><div><dt>Action</dt><dd>${escape(action)}</dd></div><div><dt>Result</dt><dd>${escape(source.label)}</dd></div><div><dt>Target</dt><dd>${escape(activityTarget(item))}</dd></div><div><dt>Record ID</dt><dd>${escape(item.id)}</dd></div></dl></div>${keys.length ? `<div class="aa-changes"><h4>What changed</h4>${changes}</div>` : '<p class="aa-detail-note">No before-and-after change is attached to this event.</p>'}<details class="aa-event-details"><summary>Event information</summary><pre>${escape(pretty(eventInformation))}</pre></details>`;
  }

  function create({ root, db, getSession, canOwner, isLocalData = () => false }) {
    const find = name => root.querySelector(`[data-aa="${name}"]`);
    root.innerHTML = `<section class="aa-panel" aria-labelledby="activityHistoryTitle"><header class="aa-header"><div><span class="aa-eyebrow">System owner only</span><h2 id="activityHistoryTitle">Activity History</h2><p>Saved changes, page views, and service checks.</p></div><button class="aa-button" type="button" data-aa="refresh">↻ <span>Refresh</span></button></header><div class="aa-scope"><span class="aa-scope-icon" aria-hidden="true">◷</span><p data-aa="started">History begins when activity recording is enabled. Earlier actions are not reconstructed.</p></div><form class="aa-filters" data-aa="filters"><label>From date<input type="date" name="fromDate" data-aa="fromDate"></label><label>To date<input type="date" name="toDate" data-aa="toDate"></label><label>Operator<select name="actorId" data-aa="actor"><option value="">All operators</option></select></label><label>Category<select name="category" data-aa="category"><option value="">All categories</option>${CATEGORIES.map(category => `<option value="${category}">${escape(words(category))}</option>`).join('')}</select></label><button class="aa-button aa-primary" type="submit">Apply filters</button><button class="aa-reset" type="button" data-aa="reset">Reset</button></form><div class="aa-meta"><span data-aa="count">No records loaded</span><span>Philippine time · newest first</span></div><div data-aa="status" class="aa-status" role="status" aria-live="polite"></div><div class="aa-table-wrap" data-aa="list"><table class="aa-table"><thead><tr><th>When</th><th>Operator</th><th>Activity</th><th>Record</th><th><span class="aa-sr-only">Details</span></th></tr></thead><tbody data-aa="rows"></tbody></table></div><footer class="aa-footer"><p>Service checks can run automatically under a signed-in account. Saved changes show recorded changes to your data.</p><button class="aa-button" type="button" data-aa="more" hidden>Load older activity</button></footer></section><dialog class="aa-dialog" data-aa="dialog" aria-labelledby="activityDetailTitle"><header><h2 id="activityDetailTitle">Activity details</h2><button class="aa-button" type="button" data-aa="close" aria-label="Close activity details">Close</button></header><div class="aa-dialog-body" data-aa="detail"></div></dialog>`;
    let filters = {}, disposed = false, dialogTrigger = null, dialogTriggerIndex = null;
    const store = createStore({ db, getSession, canOwner, onChange: render });
    function render(state) {
      if (disposed) return;
      const allowed = !!ownSessionKey(getSession(), canOwner);
      root.hidden = !allowed;
      root.setAttribute('aria-busy', String(state.loading));
      find('rows').innerHTML = allowed ? state.items.map(itemMarkup).join('') : '';
      const actorValue = find('actor').value;
      find('actor').innerHTML = '<option value="">All operators</option>' + (allowed ? state.actors.map(actor => `<option value="${escape(actor.id)}">${escape(actor.name || 'Operator')} · ${escape(roleLabel(actor.role))}</option>`).join('') : '');
      find('actor').value = actorValue;
      find('count').textContent = allowed && state.items.length ? `${state.items.length} record${state.items.length === 1 ? '' : 's'} loaded` : 'No records loaded';
      find('started').textContent = isLocalData() ? 'Local preview. Live activity is not loaded or recorded here.' : state.startedAt && allowed ? `Recording began ${dateLabel(state.startedAt)} PH. Earlier actions are not reconstructed.${state.capabilities?.authAuditCaptured === false ? ' Authentication events are browser-reported; server authentication history is unavailable.' : ''}` : 'History begins when activity recording is enabled. Earlier actions are not reconstructed.';
      const status = find('status');
      status.textContent = !allowed ? '' : state.loading ? 'Loading activity…' : state.error || (!state.items.length ? 'No activity matches these filters.' : '');
      status.setAttribute('role', state.error ? 'alert' : 'status');
      status.hidden = !status.textContent;
      find('list').hidden = !allowed || !state.items.length;
      find('refresh').disabled = state.loading;
      find('more').hidden = !allowed || !state.nextCursor;
      find('more').disabled = state.loading;
      find('detail').innerHTML = !allowed ? '' : state.detailLoading ? '<p role="status">Loading activity details…</p>' : state.detailError ? `<p role="alert">${escape(state.detailError)}</p>` : state.detail ? detailMarkup(state.detail) : '';
      if (!allowed || (!state.detail && !state.detailLoading && !state.detailError)) closeDialog();
    }
    function closeDialog() {
      const dialog = find('dialog');
      if (dialog.open) dialog.close();
      const returnTarget = dialogTrigger?.isConnected ? dialogTrigger : dialogTriggerIndex !== null ? find('rows').querySelector(`[data-aa-detail="${dialogTriggerIndex}"]`) : null;
      if (returnTarget && !root.hidden) returnTarget.focus();
      dialogTrigger = null; dialogTriggerIndex = null;
    }
    function refresh() { return store.load(filters); }
    find('refresh').addEventListener('click', refresh);
    find('more').addEventListener('click', () => store.load(filters, true));
    find('filters').addEventListener('submit', event => {
      event.preventDefault();
      const fromDate = find('fromDate').value, toDate = find('toDate').value;
      find('toDate').setCustomValidity(fromDate && toDate && toDate < fromDate ? 'Choose an end date on or after the start date.' : '');
      if (!find('filters').reportValidity()) return;
      filters = { fromDate: fromDate || undefined, toDate: toDate || undefined, actorId: find('actor').value || undefined, category: find('category').value || undefined };
      void refresh();
    });
    find('toDate').addEventListener('input', () => find('toDate').setCustomValidity(''));
    find('reset').addEventListener('click', () => { find('filters').reset(); find('toDate').setCustomValidity(''); filters = {}; void refresh(); });
    find('close').addEventListener('click', store.closeDetail);
    find('dialog').addEventListener('cancel', event => { event.preventDefault(); store.closeDetail(); });
    find('rows').addEventListener('click', event => {
      const button = event.target.closest('[data-aa-detail]');
      if (!button || !store.authorized()) return;
      const item = store.getState().items[Number(button.dataset.aaDetail)];
      if (!item) return;
      dialogTrigger = button;
      dialogTriggerIndex = Number(button.dataset.aaDetail);
      void store.detail(item.id);
      find('dialog').showModal();
      find('close').focus();
    });
    const observer = createObserver({ db, getSession, isLocalData });
    function checkSession() { store.authorized(); }
    const win = root.ownerDocument.defaultView;
    win.addEventListener('storage', checkSession);
    win.addEventListener('focus', checkSession);
    win.addEventListener('pagehide', store.clear);
    root.ownerDocument.addEventListener('visibilitychange', checkSession);
    render(store.getState());
    return { refresh, clear: store.clear, observeNavigation: observer.observeNavigation, installObservers: observer.install, destroy() { disposed = true; store.clear(); observer.destroy(); win.removeEventListener('storage', checkSession); win.removeEventListener('focus', checkSession); win.removeEventListener('pagehide', store.clear); root.ownerDocument.removeEventListener('visibilitychange', checkSession); root.innerHTML = ''; } };
  }

  // Use code identifiers, never button text, arguments, form values, or receipt contents.
  function observationFor(element, eventType = 'click') {
    if (!element || element.closest?.('[data-admin-activity]') || element.closest?.('.nav-item')) return null;
    if (element.hasAttribute?.('download')) return { category: 'export', action: 'download_requested', label: 'Download requested', outcome: 'attempt' };
    const playAction = element.getAttribute?.(eventType === 'submit' ? 'data-pm-form' : 'data-pm-action');
    if ((eventType === 'submit' ? PLAY_FORMS : PLAY_ACTIONS).has(playAction)) {
      return { category: /export|download/.test(playAction) ? 'export' : 'interaction', action: `play_manager_${eventType === 'submit' ? 'submit_' : ''}${playAction.replace(/-/g, '_')}`, outcome: 'attempt' };
    }
    const balanceAction = { hostBalanceApproveBtn: 'confirmHostBalanceReceived', hostBalanceRejectBtn: 'rejectHostBalanceReceipt' }[element.id];
    if (balanceAction) return { category: 'interaction', action: balanceAction, outcome: 'attempt' };
    const code = element.getAttribute?.(eventType === 'change' ? 'onchange' : eventType === 'submit' ? 'onsubmit' : 'onclick') || '';
    const matched = code.match(/(?:^|[;\s])(?:return\s+|void\s+)?(?:window\.)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/);
    const identifier = matched?.[1];
    if (!identifier || /^(goto|logout|toggleSidebar|close\w*|render\w*|filter\w*|toast|event\.|console\.)/i.test(identifier)) return null;
    const exporting = /export|download|print/i.test(identifier);
    return { category: exporting ? 'export' : 'interaction', action: identifier, label: words(identifier.replace(/\./g, ' ')).slice(0, 100), outcome: 'attempt' };
  }
  function createObserver({ db, getSession, isLocalData = () => false }) {
    let documentRef = null, windowRef = null;
    function record(event) {
      const session = getSession();
      if (isLocalData() || !session?.id || !['owner', 'court_owner'].includes(session.role) || !event || typeof db.recordAdminActivity !== 'function') return;
      try { Promise.resolve(db.recordAdminActivity(event)).catch(() => {}); } catch (_) { /* An observation must not interrupt an operation. */ }
    }
    function observeNavigation(section) {
      if (Object.hasOwn(SECTIONS, section)) record({ category: 'navigation', action: 'page_view', targetType: 'section', targetId: section, label: SECTIONS[section], outcome: 'view' });
    }
    function click(event) { if (event.isTrusted === false) return; record(observationFor(event.target.closest?.('button,a,[onclick],[role="button"]'))); }
    function change(event) { if (event.isTrusted === false) return; record(observationFor(event.target.closest?.('[onchange]'), 'change')); }
    function submit(event) { if (event.isTrusted === false) return; record(observationFor(event.target, 'submit')); }
    function print() { record({ category: 'export', action: 'print_requested', label: 'Print dialog opened', outcome: 'attempt' }); }
    function install(doc) { if (documentRef) return; documentRef = doc; windowRef = doc.defaultView; doc.addEventListener('click', click, true); doc.addEventListener('change', change, true); doc.addEventListener('submit', submit, true); windowRef?.addEventListener('beforeprint', print); }
    function destroy() { documentRef?.removeEventListener('click', click, true); documentRef?.removeEventListener('change', change, true); documentRef?.removeEventListener('submit', submit, true); windowRef?.removeEventListener('beforeprint', print); documentRef = null; windowRef = null; }
    return { observeNavigation, install, destroy, record };
  }
  return { create, createStore, createObserver, observationFor, itemMarkup, detailMarkup, sourceLabel, dateLabel, CATEGORIES };
});
