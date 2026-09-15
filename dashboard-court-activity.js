(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChinoCourtActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const MINUTE_MS = 60000;
  const PH_OFFSET_MS = 8 * 60 * MINUTE_MS;
  const dateFormatter = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const tvDateFormatter = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  function text(value) { return String(value ?? '').trim(); }

  function dateStart(value) {
    const date = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const utc = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) return null;
    return utc - PH_OFFSET_MS;
  }

  function timeMinutes(value, allowMidnightEnd = false) {
    const match = text(value).match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const second = Number(match[3] || 0);
    if (minute > 59 || second > 59) return null;
    if (match[4]) {
      if (hour < 1 || hour > 12) return null;
      hour = hour % 12 + (match[4].toUpperCase() === 'PM' ? 12 : 0);
    } else if (hour > 23 && !(allowMidnightEnd && hour === 24 && minute === 0 && second === 0)) {
      return null;
    }
    return hour * 60 + minute + second / 60;
  }

  function normalize(row, nowMs) {
    if (!row || typeof row !== 'object') return null;
    const status = text(row.status).toLowerCase();
    if (!['confirmed', 'pending', 'verifying'].includes(status)) return null;
    const fullName = text(row.fullName ?? row.full_name);
    const email = text(row.email).toLowerCase();
    if (email === 'reserve@hold.internal' || /^reserving(?:\.{3}|\u2026)?$/i.test(fullName)) return null;
    const date = text(row.date);
    const midnight = dateStart(date);
    const startMinutes = timeMinutes(row.startTime ?? row.start_time);
    if (midnight === null || startMinutes === null) return null;
    const startMs = midnight + startMinutes * MINUTE_MS;
    const endText = text(row.endTime ?? row.end_time);
    const duration = Number(row.duration);
    const durationMs = Number.isFinite(duration) && duration > 0 && duration <= 24
      ? duration * 60 * MINUTE_MS : null;
    let endMs;
    if (endText) {
      const endMinutes = timeMinutes(endText, true);
      if (endMinutes === null) return null;
      endMs = midnight + endMinutes * MINUTE_MS;
      if (endMs < startMs) endMs += DAY_MS;
      if (endMs === startMs) {
        if (durationMs === null) return null;
        endMs = startMs + durationMs;
      }
    } else {
      if (durationMs === null) return null;
      endMs = startMs + durationMs;
    }
    const ref = text(row.ref);
    const courtId = text(row.courtId ?? row.court_id);
    const courtName = text(row.courtName ?? row.court_name) || 'Court';
    const group = text(row.groupRef ?? row.bookingGroupRef ?? row.booking_group_ref);
    const customer = fullName.toLowerCase();
    // Without a booking group and customer identity, adjacent rows may be unrelated.
    const mergeKey = status === 'confirmed' && group && customer && (courtId || row.courtName || row.court_name)
      ? JSON.stringify([group, courtId || courtName, customer, email]) : '';
    return {
      ref, courtId, courtName, fullName: fullName || 'Guest', date, startMs, endMs,
      startLabel: timeFormatter.format(startMs), endLabel: timeFormatter.format(endMs),
      dateLabel: dateFormatter.format(startMs), status,
      minutesUntilStart: Math.ceil((startMs - nowMs) / MINUTE_MS),
      minutesUntilEnd: Math.ceil((endMs - nowMs) / MINUTE_MS),
      _mergeKey: mergeKey,
    };
  }

  function compare(a, b) {
    return a.startMs - b.startMs
      || a.courtName.localeCompare(b.courtName, undefined, { numeric: true })
      || a.fullName.localeCompare(b.fullName)
      || a.ref.localeCompare(b.ref);
  }

  function bookingSessions(raw, nowMs) {
    if (!raw || typeof raw !== 'object') return [];
    if (!Array.isArray(raw.slots) || raw.slots.length === 0) {
      const row = normalize(raw, nowMs);
      return row ? [row] : [];
    }
    // Explicit booked hours are authoritative: a row may contain gaps that its start/end labels hide.
    const hours = raw.slots.map(value => /^\d{1,2}$/.test(text(value)) ? Number(value) : NaN);
    if (hours.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 23)) return [];
    const ranges = [];
    for (const hour of [...new Set(hours)].sort((a, b) => a - b)) {
      const previous = ranges[ranges.length - 1];
      if (previous && previous.end === hour) previous.end = hour + 1;
      else ranges.push({ start: hour, end: hour + 1 });
    }
    return ranges.map(range => normalize({
      ...raw, startTime: `${range.start}:00`, endTime: `${range.end}:00`, duration: range.end - range.start,
    }, nowMs)).filter(Boolean);
  }

  function mergeSessions(rows, nowMs) {
    const sessions = [];
    const lastByGroup = new Map();
    for (const row of rows.sort(compare)) {
      const previous = row._mergeKey ? lastByGroup.get(row._mergeKey) : null;
      if (previous && row.startMs <= previous.endMs) {
        previous.endMs = Math.max(previous.endMs, row.endMs);
        previous.endLabel = timeFormatter.format(previous.endMs);
        previous.minutesUntilEnd = Math.ceil((previous.endMs - nowMs) / MINUTE_MS);
      } else {
        sessions.push(row);
        if (row._mergeKey) lastByGroup.set(row._mergeKey, row);
      }
    }
    return sessions.map(({ _mergeKey, ...row }) => row).sort(compare);
  }

  function buildSnapshot(bookings, { now = new Date() } = {}) {
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError('A valid current time is required.');
    const today = new Date(nowMs + PH_OFFSET_MS).toISOString().slice(0, 10);
    const todayStart = dateStart(today);
    // Seven Philippine calendar dates, including today; an overnight session can extend beyond the edge.
    const horizonEnd = todayStart + 7 * DAY_MS;
    const seenRefs = new Set();
    const normalized = [];
    for (const raw of Array.isArray(bookings) ? bookings : []) {
      const rows = bookingSessions(raw, nowMs);
      if (!rows.length) continue;
      const ref = rows[0].ref;
      if (ref && seenRefs.has(ref)) continue;
      if (ref) seenRefs.add(ref);
      normalized.push(...rows);
    }
    // Merge before time filtering so a continuing booking retains its original start time.
    const sessions = mergeSessions(normalized, nowMs);
    const relevant = sessions.filter(row => row.endMs > nowMs && row.startMs < horizonEnd);
    const confirmed = relevant.filter(row => row.status === 'confirmed');
    const playing = confirmed.filter(row => row.startMs <= nowMs);
    const future = confirmed.filter(row => row.startMs > nowMs);
    const nextStart = future[0]?.startMs;
    const next = future.filter(row => row.startMs === nextStart);
    const upcoming = future.filter(row => row.startMs !== nextStart);
    const pending = relevant.filter(row => row.status !== 'confirmed');
    return {
      today, dateLabel: dateFormatter.format(nowMs), nowIso: new Date(nowMs).toISOString(),
      playing, next, upcoming, pending,
      counts: { playing: playing.length, next: next.length, upcoming: upcoming.length, pending: pending.length },
    };
  }

  function publicDisplayName(value) {
    const parts = text(value).replace(/\s+/g, ' ').split(' ').filter(Boolean);
    if (!parts.length) return 'Guest';
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  }

  function courtNumber(item) {
    const nameMatch = text(item?.courtName).match(/(?:^|\s)([1-4])(?:\s|$)/);
    if (nameMatch) return Number(nameMatch[1]);
    const idMatch = text(item?.courtId).match(/([1-4])$/);
    return idMatch ? Number(idMatch[1]) : null;
  }

  function tomorrowDateKey({ now = new Date() } = {}) {
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError('A valid current time is required.');
    const today = new Date(nowMs + PH_OFFSET_MS).toISOString().slice(0, 10);
    return new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  }

  function buildTvAvailabilitySnapshot(raw, { now = new Date() } = {}) {
    const expectedDate = tomorrowDateKey({ now });
    if (!raw || typeof raw !== 'object' || raw.date !== expectedDate || raw.timezone !== 'Asia/Manila') {
      throw new TypeError('Tomorrow availability must be a current Philippine-time snapshot.');
    }
    const generatedAt = text(raw.generatedAt ?? raw.asOf);
    if (!Number.isFinite(Date.parse(generatedAt)) || !Array.isArray(raw.courts) || raw.courts.length === 0) {
      throw new TypeError('Tomorrow availability is incomplete.');
    }
    const courts = raw.courts.map((court, courtIndex) => {
      const id = text(court?.id);
      const name = text(court?.name) || `Court ${courtIndex + 1}`;
      if (!id || !Array.isArray(court?.slots)) throw new TypeError('Court availability is incomplete.');
      const slots = court.slots.map(slot => {
        const state = text(slot?.state);
        const reason = text(slot?.reason);
        const startHour = Number(slot?.startHour ?? slot?.hour);
        const endHour = Number(slot?.endHour);
        const startLabel = text(slot?.startLabel);
        const endLabel = text(slot?.endLabel);
        if (!['free', 'unavailable'].includes(state) || !Number.isInteger(startHour) ||
            !Number.isInteger(endHour) || endHour !== startHour + 1 || !startLabel || !endLabel) {
          throw new TypeError('Court availability contains an invalid time slot.');
        }
        const availability = state === 'free' ? 'available'
          : reason === 'booked' ? 'booked'
          : ['blocked_date', 'pre_opening'].includes(reason) ? 'closed'
          : 'unavailable';
        return {
          startHour,
          endHour,
          startLabel,
          endLabel,
          label: `${startLabel} – ${endLabel}`,
          availability,
        };
      });
      return {
        id,
        name,
        slots,
        availableCount: slots.filter(slot => slot.availability === 'available').length,
      };
    }).sort((left, right) => {
      const leftNumber = courtNumber({ courtId: left.id, courtName: left.name });
      const rightNumber = courtNumber({ courtId: right.id, courtName: right.name });
      return (leftNumber ?? 999) - (rightNumber ?? 999) || left.name.localeCompare(right.name, undefined, { numeric: true });
    });
    const tomorrowStart = dateStart(expectedDate);
    return {
      date: expectedDate,
      dateLabel: tvDateFormatter.format(tomorrowStart + 12 * 60 * MINUTE_MS),
      generatedAt,
      courts,
      totalAvailable: courts.reduce((total, court) => total + court.availableCount, 0),
    };
  }

  function tvSession(item) {
    return {
      courtName: item.courtName,
      displayName: publicDisplayName(item.fullName),
      startMs: item.startMs,
      endMs: item.endMs,
      startLabel: item.startLabel,
      endLabel: item.endLabel,
      minutesUntilStart: item.minutesUntilStart,
      minutesUntilEnd: item.minutesUntilEnd,
    };
  }

  function buildTvSnapshot(bookings, { now = new Date() } = {}) {
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError('A valid current time is required.');
    const snapshot = buildSnapshot(bookings, { now });
    const todayStart = dateStart(snapshot.today);
    const tomorrowStart = todayStart + DAY_MS;
    const todaySessions = [...snapshot.playing, ...snapshot.next, ...snapshot.upcoming]
      .filter(item => item.endMs > todayStart && item.startMs < tomorrowStart);
    const courts = [1, 2, 3, 4].map(number => {
      const sessions = todaySessions.filter(item => courtNumber(item) === number).sort(compare);
      const playing = sessions.find(item => item.startMs <= nowMs && item.endMs > nowMs) || null;
      const future = sessions.filter(item => item.startMs > nowMs);
      return {
        number,
        name: `Court ${number}`,
        playing: playing ? tvSession(playing) : null,
        upNext: future.length ? tvSession(future[0]) : null,
        upcoming: future.slice(1).map(tvSession),
      };
    });
    return {
      today: snapshot.today,
      dateLabel: tvDateFormatter.format(nowMs),
      nowIso: new Date(nowMs).toISOString(),
      courts,
      upcomingToday: courts.flatMap(court => court.upcoming).sort((a, b) =>
        a.startMs - b.startMs || a.courtName.localeCompare(b.courtName, undefined, { numeric: true })
      ),
    };
  }

  return { buildSnapshot, buildTvSnapshot, buildTvAvailabilitySnapshot, tomorrowDateKey, publicDisplayName };
});
