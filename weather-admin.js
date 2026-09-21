(function () {
  'use strict';
  const { escape: esc, today, hour, key, affected, labels } = WeatherUtils;
  let desk, state, selection = new Map(), sequence = 0, busy = false;
  let requestKey = null;
  const el = id => document.getElementById(id);
  function feedback(message = '', kind = '') {
    el('wxFeedback').textContent = message;
    el('wxFeedback').className = `wx-feedback ${kind}`;
    el('wxFeedback').hidden = !message;
  }
  function selectedSlots() { return [...selection.values()]; }
  function updateSelection() {
    const count = selection.size;
    const impacted = state ? affected(state.bookings, selectedSlots()) : [];
    el('wxSelection').textContent = `${count} time slot${count === 1 ? '' : 's'} selected`;
    el('wxImpact').textContent = `${impacted.length} booking${impacted.length === 1 ? '' : 's'} affected · full booked hours protected`;
    el('wxReview').disabled = !count || busy;
    desk.querySelectorAll('[data-slot]').forEach(button => button.setAttribute('aria-pressed', String(selection.has(button.dataset.slot))));
  }
  function draw() {
    const filteredCourts = state.courts.filter(c => !el('wxCourt').value || String(c.id) === el('wxCourt').value);
    const closed = new Set(state.slots.map(s => key(s.courtId, s.hour)));
    const phHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const pastDate = state.date < today();
    el('wxGrid').innerHTML = filteredCourts.map(c => {
      const bookings = state.bookings.filter(b => String(b.courtId) === String(c.id));
      const hours = Array.from({ length: Math.max(0, state.closeHour - state.openHour) }, (_, i) => state.openHour + i);
      return `<section class="wx-court"><div class="wx-court-header"><h3>${esc(c.name)}</h3><button type="button" class="wx-button" data-all="${esc(c.id)}">Select remaining hours</button></div><div class="wx-slots">${hours.map(h => {
        const id = key(c.id, h), isClosed = closed.has(id), booking = bookings.find(b => b.slots.map(Number).includes(h));
        const past = pastDate || (state.date === today() && h < phHour);
        const label = isClosed ? 'Weather closed' : booking ? `Booked · ${booking.name || booking.ref}` : 'Available';
        return `<button type="button" class="wx-slot ${isClosed ? 'closed' : booking ? 'booked' : ''} ${past ? 'past' : ''}" data-slot="${esc(id)}" aria-pressed="${selection.has(id)}" aria-label="${esc(c.name)} ${hour(h)} to ${hour(h + 1)}, ${esc(label)}" ${isClosed || past || busy ? 'disabled' : ''}><strong>${hour(h)} – ${hour(h + 1)}</strong><small>${esc(label)}</small></button>`;
      }).join('')}</div></section>`;
    }).join('') || '<p class="wx-empty">Add a court to start managing weather closures.</p>';
    el('wxHistory').innerHTML = state.closures.map(c => `<div class="wx-row"><div><strong>${esc(labels[c.reason] || 'Weather closure')}</strong><p>${c.reopenedAt ? 'Reopened · replacement rights preserved' : `${c.slots} closed time slots`}</p></div>${c.reopenedAt ? '<span class="wx-status">Reopened</span>' : `<button type="button" class="wx-button" data-reopen="${esc(c.id)}">Reopen slots</button>`}</div>`).join('') || '<p class="wx-empty">No weather closures on this date.</p>';
    el('wxPlayers').innerHTML = state.replacements.map(r => `<div class="wx-row"><div><strong>${esc(r.name)}</strong><p>${esc(r.family)} · ${esc(r.email || 'No email on booking')}</p><p>${r.pending ? `${r.pending} booking${r.pending === 1 ? '' : 's'} awaiting a new time` : 'Replacement handled'}</p><span class="wx-status ${esc(r.emailStatus)}">${({ sent: 'Email sent', pending: 'Email queued', sending: 'Sending email', failed: 'Email needs attention' })[r.emailStatus] || 'Email queued'}</span>${r.emailError ? `<p>${esc(r.emailError)}</p>` : ''}</div><div class="wx-row-actions"><button type="button" class="wx-button" data-copy="${esc(r.id)}">Copy player link</button>${['failed', 'sent'].includes(r.emailStatus) ? `<button type="button" class="wx-button" data-retry="${esc(r.id)}">Resend email</button>` : ''}</div></div>`).join('') || '<p class="wx-empty">Affected players and email delivery will appear here.</p>';
    updateSelection();
  }
  async function load({ clear = true, keepMessage = false } = {}) {
    const ticket = ++sequence;
    if (clear) { selection.clear(); requestKey = null; }
    if (!keepMessage) feedback();
    el('wxGrid').innerHTML = '<p class="wx-empty" role="status">Loading court schedule…</p>';
    el('wxHistory').innerHTML = '<p class="wx-empty">Loading closures…</p>';
    el('wxPlayers').innerHTML = '<p class="wx-empty">Loading player notifications…</p>';
    el('wxReview').disabled = true;
    state = null;
    try {
      const data = await WeatherAPI.call('get_weather_desk', { p_date: el('wxDate').value });
      if (ticket !== sequence) return;
      state = { ...data, courts: [...data.courts].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' })) };
      const selected = el('wxCourt').value;
      el('wxCourt').innerHTML = '<option value="">All courts</option>' + state.courts.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      el('wxCourt').value = state.courts.some(c => String(c.id) === selected) ? selected : '';
      draw();
    } catch (error) {
      if (ticket !== sequence) return;
      feedback(error.message, 'error');
      el('wxGrid').innerHTML = '<p class="wx-empty">Schedule unavailable. Please refresh to try again.</p>';
      updateSelection();
    }
  }
  function review() {
    if (!state || !selection.size || busy) return;
    const bookings = affected(state.bookings, selectedSlots());
    const families = new Set(bookings.filter(b => b.email !== 'reserve@hold.internal').map(b => b.groupRef || b.ref));
    el('wxReviewSummary').textContent = `Close ${selection.size} time slot${selection.size === 1 ? '' : 's'} on ${state.date}. ${families.size} player notification${families.size === 1 ? '' : 's'} will be queued for affected booking groups.`;
    el('wxReviewTimes').innerHTML = state.courts.map(c => {
      const hours = selectedSlots().filter(s => String(s.courtId) === String(c.id)).map(s => s.hour).sort((a, b) => a - b);
      return hours.length ? `<p><b>${esc(c.name)}</b> · ${hours.map(h => `${hour(h)}–${hour(h + 1)}`).join(', ')}</p>` : '';
    }).join('');
    el('wxReviewList').innerHTML = bookings.map(b => `<li>${esc(b.name || b.ref)} · ${esc(b.ref)} · ${b.slots.length} hour${b.slots.length === 1 ? '' : 's'} protected</li>`).join('') || '<li>No existing bookings are affected.</li>';
    el('wxConfirmError').hidden = true;
    requestKey ||= crypto.randomUUID();
    el('wxConfirmDialog').showModal();
  }
  async function confirm() {
    if (busy || !state || !selection.size) return;
    busy = true;
    el('wxConfirm').disabled = true;
    el('wxCancel').disabled = true;
    el('wxConfirm').textContent = 'Closing slots…';
    try {
      await WeatherAPI.call('create_weather_closure', { p_date: state.date, p_slots: selectedSlots(), p_reason: el('wxReason').value, p_request_key: requestKey, p_expected_refs: affected(state.bookings, selectedSlots()).map(b => b.ref) });
      el('wxConfirmDialog').close();
      feedback(window.PB_USE_LOCAL_DATA ? 'Preview closure saved. No real bookings or emails were changed.' : 'Weather closure saved. Affected players can reschedule at no extra charge. Emails are queued for delivery.', 'success');
      DB.clearCache?.(['settings', 'bookings']);
      WeatherAPI.dispatch().catch(() => {});
      await load({ keepMessage: true });
    } catch (error) {
      el('wxConfirmError').textContent = error.message;
      el('wxConfirmError').hidden = false;
    } finally {
      busy = false;
      el('wxConfirm').disabled = false;
      el('wxCancel').disabled = false;
      el('wxConfirm').textContent = 'Close slots & notify';
      if (state) draw();
    }
  }
  async function action(button) {
    if (busy || button.disabled) return;
    button.disabled = true;
    try {
      if (button.dataset.reopen) {
        await WeatherAPI.call('reopen_weather_closure', { p_id: button.dataset.reopen });
        DB.clearCache?.(['settings', 'bookings']);
        feedback('Slots reopened. Players keep their weather replacement rights.', 'success');
        await load({ keepMessage: true });
      } else if (button.dataset.retry) {
        await WeatherAPI.call('retry_weather_email', { p_replacement_id: button.dataset.retry });
        WeatherAPI.dispatch().catch(() => {});
        feedback('Notification queued. Recently sent emails have a one-minute resend cooldown.', 'success');
        await load({ keepMessage: true });
      } else if (button.dataset.copy) {
        const token = await WeatherAPI.call('get_weather_owner_link', { p_replacement_id: button.dataset.copy });
        await navigator.clipboard.writeText(`${location.origin}/weather-reschedule#${token}`);
        feedback('Private player link copied. Share it only with this booking’s player.', 'success');
      }
    } catch (error) { feedback(error.message, 'error'); }
    finally { button.disabled = false; }
  }
  function init() {
    desk = el('weatherDesk');
    if (desk.dataset.ready) return;
    desk.dataset.ready = 'true';
    desk.innerHTML = `<header class="wx-hero"><div class="wx-chip">Court care · Player first</div><p class="wx-eyebrow">WEATHER CLOSURES</p><h2>Rain changes plans.<br>Keep their next game covered.</h2><p>Close unsafe court hours, notify your players, and give them a new time with every paid hour protected.</p></header><div id="wxFeedback" class="wx-feedback" role="status" aria-live="polite" hidden></div><section class="wx-panel"><div class="wx-toolbar"><label class="wx-field">Date<input id="wxDate" type="date" value="${today()}"></label><label class="wx-field">Court<select id="wxCourt"><option value="">All courts</option></select></label><button id="wxRefresh" type="button" class="wx-button">Refresh schedule</button></div><div class="wx-legend"><span><i class="wx-dot"></i>Available</span><span><i class="wx-dot booked"></i>Booked</span><span><i class="wx-dot closed"></i>Weather closed</span><span><i class="wx-dot selected"></i>Selected</span></div><div id="wxGrid"></div></section><div class="wx-sticky"><div><strong id="wxSelection">0 time slots selected</strong><small id="wxImpact">Select the hours affected by weather</small></div><button id="wxReview" class="wx-button primary" type="button" disabled>Review closure</button></div><section class="wx-panel"><h3>Closures for this date</h3><p class="wx-subtitle">Reopen when the court is safe. Existing player replacements stay protected.</p><div id="wxHistory"></div></section><section class="wx-panel"><h3>Player care</h3><p class="wx-subtitle">Track replacement bookings and email delivery. Refresh to see the latest updates.</p><div id="wxPlayers"></div></section><dialog id="wxConfirmDialog" class="wx-dialog" aria-labelledby="wxDialogTitle"><div class="wx-dialog-inner"><p class="wx-eyebrow" style="color:#326da5">REVIEW WEATHER CLOSURE</p><h2 id="wxDialogTitle">Keep everyone in the loop.</h2><p id="wxReviewSummary"></p><div id="wxReviewTimes" class="wx-review-times"></div><label class="wx-field">Reason<select id="wxReason"><option value="rain">Rain</option><option value="wet_court">Wet court</option><option value="unsafe_weather">Unsafe weather</option></select></label><ul id="wxReviewList"></ul><div class="wx-note">An affected reservation receives its full booked duration on the same court. Its payment and original booking fee carry over, even if the new time costs more. Any original unpaid balance stays unchanged.</div><p id="wxConfirmError" class="wx-feedback error" role="alert" hidden></p></div><div class="wx-dialog-footer"><button id="wxCancel" class="wx-button" type="button">Go back</button><button id="wxConfirm" class="wx-button primary" type="button">Close slots & notify</button></div></dialog>`;
    el('wxDate').addEventListener('change', () => load());
    el('wxCourt').addEventListener('change', () => { if (state) draw(); });
    el('wxRefresh').addEventListener('click', () => load());
    el('wxReview').addEventListener('click', review);
    el('wxCancel').addEventListener('click', () => el('wxConfirmDialog').close());
    el('wxConfirmDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    el('wxConfirm').addEventListener('click', confirm);
    desk.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || busy || button.disabled) return;
      if (button.dataset.slot) {
        const [courtId, h] = JSON.parse(button.dataset.slot);
        selection.has(button.dataset.slot) ? selection.delete(button.dataset.slot) : selection.set(button.dataset.slot, { courtId, hour: h });
        requestKey = null;
        updateSelection();
      } else if (button.dataset.all) {
        desk.querySelectorAll('[data-slot]:not(:disabled)').forEach(slot => {
          const [courtId, h] = JSON.parse(slot.dataset.slot);
          if (courtId === button.dataset.all) selection.set(slot.dataset.slot, { courtId, hour: h });
        });
        requestKey = null;
        updateSelection();
      } else if (button.dataset.reopen || button.dataset.retry || button.dataset.copy) action(button);
    });
  }
  window.WeatherClosures = { async render() { init(); await load(); } };
})();
