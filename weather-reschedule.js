(function () {
  'use strict';
  const { escape: esc, today, hour } = WeatherUtils;
  const token = location.hash.slice(1);
  // URL fragments stay off the network; keep the private link usable on refresh.
  const container = document.getElementById('wxPlayerItems');
  const message = document.getElementById('wxPlayerMessage');
  const selections = new Map(), sequences = new Map();
  let state, saving = false;
  function notice(text, kind = '') { message.textContent = text; message.className = `wx-feedback ${kind}`; message.hidden = !text; }
  function timeRange(slots) {
    const sorted = (slots || []).map(Number).sort((a, b) => a - b);
    return sorted.length ? `${hour(sorted[0])} – ${hour(sorted[sorted.length - 1] + 1)}` : '';
  }
  function render() {
    container.innerHTML = state.items.map((item, index) => `<section class="wx-panel wx-player-item" data-item="${esc(item.id)}"><p class="wx-eyebrow" style="color:#64778c">${esc(item.ref)} · ${item.duration} HOUR${item.duration === 1 ? '' : 'S'}</p><h3>${esc(item.court)}</h3><p class="wx-original">Original booking: ${esc(item.oldDate)} · ${timeRange(item.oldSlots)}</p>${item.status === 'completed' ? `<div class="wx-feedback success"><b>Your new time is confirmed</b><br>${esc(item.newDate)} · ${timeRange(item.newSlots)}<br>Updated confirmation email queued. No extra charge.</div>` : item.status !== 'pending' ? '<div class="wx-note">This booking has already been updated. Contact CHINO if you need more help.</div>' : `<label class="wx-field" for="wxNewDate${index}">Choose your new date<input type="date" id="wxNewDate${index}" min="${today()}" data-date="${esc(item.id)}"></label><div class="wx-options" aria-live="polite"><p class="wx-empty">Choose a date to see available times.</p></div><div class="wx-note wx-summary">Your full ${item.duration}-hour reservation will move together.</div><button class="wx-button primary" style="width:100%;margin-top:16px" type="button" data-confirm="${esc(item.id)}" disabled>Confirm new time · ₱0 extra</button>`}</section>`).join('');
  }
  async function loadOptions(input) {
    const id = input.dataset.date;
    const section = input.closest('[data-item]'), options = section.querySelector('.wx-options');
    const ticket = (sequences.get(id) || 0) + 1;
    sequences.set(id, ticket);
    selections.delete(id);
    section.querySelector('[data-confirm]').disabled = true;
    if (!input.value) { options.innerHTML = '<p class="wx-empty">Choose a date to see available times.</p>'; return; }
    options.innerHTML = '<p class="wx-empty">Finding your next game…</p>';
    try {
      const data = await WeatherAPI.call('get_weather_replacement_options', { p_token: token, p_item_id: id, p_date: input.value });
      if (sequences.get(id) !== ticket) return;
      options.innerHTML = data.starts.length ? `<div class="wx-slots">${data.starts.map(h => `<button type="button" class="wx-slot" data-start="${h}" aria-pressed="false"><strong>${hour(h)} – ${hour(h + data.duration)}</strong><small>${data.duration} hours · no extra charge</small></button>`).join('')}</div>` : '<p class="wx-empty">No complete time slots on this date. Try another day.</p>';
    } catch (error) {
      if (sequences.get(id) === ticket) options.innerHTML = `<p class="wx-feedback error">${esc(error.message)}</p>`;
    }
  }
  container.addEventListener('change', event => { if (event.target.dataset.date && !saving) loadOptions(event.target); });
  container.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || saving) return;
    const section = button.closest('[data-item]'), id = section.dataset.item;
    if (button.dataset.start !== undefined) {
      const start = Number(button.dataset.start), date = section.querySelector('[data-date]').value;
      const item = state.items.find(i => i.id === id);
      selections.set(id, { date, start });
      section.querySelectorAll('[data-start]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      section.querySelector('.wx-summary').textContent = `New schedule: ${date} · ${hour(start)} – ${hour(start + item.duration)}. Your original payment carries over.`;
      section.querySelector('[data-confirm]').disabled = false;
    } else if (button.dataset.confirm && selections.has(id)) {
      const choice = selections.get(id);
      saving = true;
      container.querySelectorAll('button,input').forEach(control => { control.disabled = true; });
      button.textContent = 'Confirming your new time…';
      notice('Saving your replacement. Please keep this page open.');
      try {
        state = await WeatherAPI.call('confirm_weather_replacement', { p_token: token, p_item_id: id, p_date: choice.date, p_start: choice.start });
        notice('Your new time is confirmed. Your payment and booking fee have carried over.', 'success');
        selections.clear();
        render();
      } catch (error) {
        notice(error.message, 'error');
        container.querySelectorAll('input,[data-start]').forEach(control => { control.disabled = false; });
        container.querySelectorAll('[data-confirm]').forEach(control => { control.disabled = !selections.has(control.dataset.confirm); });
        button.textContent = 'Confirm new time · ₱0 extra';
        // Refresh competing availability before another attempt.
        await loadOptions(section.querySelector('[data-date]'));
      } finally { saving = false; }
    }
  });
  (async () => {
    try {
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Open the private link in your weather closure email to choose a new time.');
      state = await WeatherAPI.call('get_weather_replacement', { p_token: token });
      notice(`Hi ${state.name}. Your original price is protected, including when the new time normally costs more.`);
      render();
    } catch (error) { notice(error.message, 'error'); }
  })();
})();
