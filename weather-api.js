(function (root) {
  'use strict';
  const labels = { rain: 'Closed due to rain', wet_court: 'Closed · wet court', unsafe_weather: 'Closed · unsafe weather' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const hour = value => `${Number(value) % 12 || 12}${Number(value) % 24 < 12 ? 'am' : 'pm'}`;
  const key = (court, h) => JSON.stringify([String(court), Number(h)]);
  const affected = (bookings, slots) => bookings.filter(b => slots.some(s => String(s.courtId) === String(b.courtId) && b.slots.map(Number).includes(Number(s.hour))));
  const rules = slots => slots.map(s => ({ enabled: true, mode: 'specific', dates: [s.date], courtIds: [s.courtId], start: Number(s.hour), end: Number(s.hour) + 1, label: s.reason, weatherClosure: true }));
  const utilities = { labels, escape, today, hour, key, affected, rules };
  if (typeof module !== 'undefined') module.exports = utilities;
  if (!root) return;
  root.WeatherUtils = utilities;
  const demoKey = 'chino_weather_demo_v1';
  const demoRead = () => JSON.parse(localStorage.getItem(demoKey) || '{"closures":[],"slots":[],"replacements":[]}');
  async function demo(name, args) {
    const saved = demoRead();
    if (name === 'get_public_weather_closures') return saved.slots.filter(s => s.active !== false);
    if (name === 'get_weather_desk') {
      const [courts, bookings, settings] = await Promise.all([DB.getCourts(), DB.getBookings({ date: args.p_date }), DB.getSettings()]);
      return { date: args.p_date, courts, openHour: Number(settings.open_hour ?? 6), closeHour: Number(settings.close_hour ?? 24), bookings: bookings.filter(b => !['cancelled', 'forfeited'].includes(b.status)).map(b => ({ ...b, name: b.fullName, groupRef: b.bookingGroupRef })), slots: saved.slots.filter(s => s.date === args.p_date && s.active !== false), closures: saved.closures.filter(c => c.date === args.p_date), replacements: saved.replacements };
    }
    if (name === 'create_weather_closure') {
      const id = crypto.randomUUID();
      saved.closures.push({ id, date: args.p_date, reason: args.p_reason, slots: args.p_slots.length });
      saved.slots.push(...args.p_slots.map(s => ({ ...s, date: args.p_date, reason: args.p_reason, closureId: id })));
      localStorage.setItem(demoKey, JSON.stringify(saved));
      return { id };
    }
    if (name === 'reopen_weather_closure') {
      saved.closures.find(c => c.id === args.p_id).reopenedAt = new Date().toISOString();
      saved.slots.filter(s => s.closureId === args.p_id).forEach(s => { s.active = false; });
      localStorage.setItem(demoKey, JSON.stringify(saved));
      return;
    }
    throw new Error('Player replacement links are available for real bookings. This is a local preview.');
  }
  root.WeatherAPI = {
    async call(name, args = {}) {
      if (root.PB_USE_LOCAL_DATA) return demo(name, args);
      const { data, error } = await _sb.rpc(name, args);
      if (error) throw new Error(error.message || 'The weather service is unavailable. Please try again.');
      return data;
    },
    async dispatch() {
      if (root.PB_USE_LOCAL_DATA) return;
      const { error } = await _sb.functions.invoke('weather-notifications', { body: {} });
      if (error) throw new Error('Emails are queued and will retry automatically.');
    },
  };
})(typeof window === 'undefined' ? null : window);
