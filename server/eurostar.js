// Eurostar: its own open data, free, no key (Eurostar International Ltd, published on France's
// national transport data portal).
//   - Timetable: GTFS, the next 90 days, republished every evening at 22:00 Paris time
//   - Live: GTFS-Realtime trip updates (delays, cancellations, skipped stops) and service alerts
// Eurostar publishes no train positions, so Eurostar trains aren't drawn on the map; stations,
// boards and train pages are live.
//
// Station codes in the app: "EZ" + the stop's id (letters and digits). Train ids:
// "ez:<train number>:<YYYYMMDD>".

import { unzipSync, strFromU8 } from 'fflate';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const STATIC_URL = process.env.EUROSTAR_GTFS || 'https://integration-storage.dm.eurostar.com/gtfs-prod/gtfs_static_commercial_v2.zip';
const RT_URL = process.env.EUROSTAR_GTFS_RT || 'https://www.data.gouv.fr/api/1/datasets/r/9c3a3d5c-a52c-451e-89c8-32822af20bee';
export const EZ_CREDIT = 'Times: Eurostar open data';

// ---- small CSV reader (GTFS files are plain CSV with a header row; fields may be quoted) ----
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---- time zones: GTFS times are local to the agency; boards show each station's own local time ----
function offsetMin(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000;
}
// "20261116" + "25:10:00" in tz -> epoch ms (GTFS times can pass 24:00)
export function epochOf(ymd, hms, tz) {
  const [h, m, s] = String(hms).split(':').map(Number);
  const base = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + ((h * 60 + m) * 60 + (s || 0)) * 1000;
  return base - offsetMin(tz, base) * 60000;
}
export const clockIn = (ms, tz) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ymdIn = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }).replace(/-/g, '');
const codeOf = (stopId) => 'EZ' + String(stopId).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);

export function createEurostar() {
  return { stops: new Map(), stations: new Map(), trips: new Map(), times: new Map(), services: new Map(), tz: 'Europe/Paris',
    rt: new Map(), alerts: [], loadedAt: 0, rtAt: 0, error: null, rtError: null };
}

// Load the timetable from the zip's files
export function loadGtfsFiles(ez, files) {
  const read = (n) => (files[n] ? parseCsv(strFromU8(files[n])) : []);
  const agency = read('agency.txt')[0];
  if (agency && agency.agency_timezone) ez.tz = agency.agency_timezone;
  ez.stops = new Map(); ez.stations = new Map();
  const raw = read('stops.txt');
  for (const s of raw) ez.stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon), parent: s.parent_station || null, tz: s.stop_timezone || null });
  // a station is a stop with no parent (platforms and quays roll up to their station)
  for (const s of ez.stops.values()) {
    const top = s.parent && ez.stops.get(s.parent) ? ez.stops.get(s.parent) : s;
    if (!ez.stations.has(top.id) && top.lat && top.lon) ez.stations.set(top.id, { crs: codeOf(top.id), id: top.id, name: top.name, lat: top.lat, lon: top.lon, tz: top.tz || s.tz || null, country: 'ez' });
  }
  ez.trips = new Map(read('trips.txt').map((t) => [t.trip_id, { id: t.trip_id, route: t.route_id, service: t.service_id, num: t.trip_short_name || t.trip_headsign || '', headsign: t.trip_headsign || '' }]));
  ez.times = new Map();
  for (const st of read('stop_times.txt')) {
    const list = ez.times.get(st.trip_id) || ez.times.set(st.trip_id, []).get(st.trip_id);
    list.push({ stop: st.stop_id, seq: Number(st.stop_sequence), arr: st.arrival_time || st.departure_time, dep: st.departure_time || st.arrival_time });
  }
  for (const l of ez.times.values()) l.sort((a, b) => a.seq - b.seq);
  // which services run on which dates (calendar + calendar_dates exceptions)
  ez.services = new Map();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const c of read('calendar.txt')) ez.services.set(c.service_id, { start: c.start_date, end: c.end_date, days: days.map((d) => c[d] === '1'), add: new Set(), remove: new Set() });
  for (const d of read('calendar_dates.txt')) {
    const s = ez.services.get(d.service_id) || ez.services.set(d.service_id, { start: null, end: null, days: [], add: new Set(), remove: new Set() }).get(d.service_id);
    (d.exception_type === '1' ? s.add : s.remove).add(d.date);
  }
  ez.loadedAt = Date.now();
  return ez.stations.size;
}

export async function loadEurostar(ez) {
  const res = await fetch(STATIC_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Eurostar timetable returned ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return loadGtfsFiles(ez, files);
}

const runsOn = (ez, serviceId, ymd) => {
  const s = ez.services.get(serviceId);
  if (!s) return false;
  if (s.remove.has(ymd)) return false;
  if (s.add.has(ymd)) return true;
  if (!s.start || ymd < s.start || ymd > s.end) return false;
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay();
  return Boolean(s.days[d]);
};

// ---- live: trip updates and alerts ----
export function applyFeed(ez, feed, now = Date.now()) {
  const rt = new Map();
  const alerts = [];
  for (const e of feed.entity || []) {
    if (e.tripUpdate) {
      const tu = e.tripUpdate, trip = tu.trip || {};
      const key = (trip.tripId || '') + '|' + (trip.startDate || '');
      rt.set(key, {
        cancelled: trip.scheduleRelationship === 3 || trip.scheduleRelationship === 'CANCELED',
        stops: (tu.stopTimeUpdate || []).map((u) => ({
          seq: u.stopSequence != null ? Number(u.stopSequence) : null, stop: u.stopId || null,
          arr: u.arrival ? { time: u.arrival.time ? Number(u.arrival.time) * 1000 : null, delay: u.arrival.delay != null ? Number(u.arrival.delay) : null } : null,
          dep: u.departure ? { time: u.departure.time ? Number(u.departure.time) * 1000 : null, delay: u.departure.delay != null ? Number(u.departure.delay) : null } : null,
          skipped: u.scheduleRelationship === 1 || u.scheduleRelationship === 'SKIPPED'
        })),
        delay: tu.delay != null ? Number(tu.delay) : null
      });
    }
    if (e.alert) {
      const text = (t) => { const tr = (t && t.translation) || []; return (tr.find((x) => /^en/i.test(x.language || '')) || tr[0] || {}).text || null; };
      alerts.push({ header: text(e.alert.headerText), body: text(e.alert.descriptionText),
        trips: (e.alert.informedEntity || []).map((x) => x.trip && x.trip.tripId).filter(Boolean),
        stops: (e.alert.informedEntity || []).map((x) => x.stopId).filter(Boolean),
        routes: (e.alert.informedEntity || []).map((x) => x.routeId).filter(Boolean) });
    }
  }
  ez.rt = rt; ez.alerts = alerts; ez.rtAt = now; ez.rtError = null;
}

export async function pollEurostarRt(ez) {
  const res = await fetch(RT_URL, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
  if (!res.ok) throw new Error(`Eurostar live feed returned ${res.status}`);
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.toObject(
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer())), { longs: Number, enums: String });
  applyFeed(ez, feed);
}

// One call of one trip on one date: booked and live times (ms), and whether it's cancelled there
function callTimes(ez, trip, ymd, call, rt) {
  const bArr = epochOf(ymd, call.arr, ez.tz), bDep = epochOf(ymd, call.dep, ez.tz);
  const u = rt && rt.stops.find((x) => (x.seq != null && x.seq === call.seq) || (x.stop && x.stop === call.stop));
  // a stop update applies to later stops too until the next update (GTFS-RT delay propagation)
  let carry = null;
  if (rt && !u) for (const x of rt.stops) { if (x.seq != null && x.seq < call.seq) carry = x; }
  const lateOf = (side, booked) => {
    const v = u ? u[side] : carry ? (carry.dep || carry.arr) : null;
    if (!v) return { live: rt && rt.delay != null ? booked + rt.delay * 1000 : null };
    return { live: v.time || (v.delay != null ? booked + v.delay * 1000 : null) };
  };
  return { bArr, bDep, eArr: lateOf('arr', bArr).live, eDep: lateOf('dep', bDep).live, skipped: Boolean(u && u.skipped), cancelled: Boolean(rt && rt.cancelled) };
}
const minsBetween = (a, b) => (a == null || b == null ? null : Math.round((b - a) / 60000));
const alertFor = (ez, tripId, stopIds) => {
  const a = ez.alerts.find((x) => x.trips.includes(tripId)) || ez.alerts.find((x) => x.stops.some((s) => stopIds.includes(s)));
  return a ? [a.header, a.body].filter(Boolean).join(' — ') : null;
};

// A station board, in the boards' shape
export function ezBoard(ez, code, type = 'dep', now = Date.now()) {
  const st = [...ez.stations.values()].find((s) => s.crs === code);
  if (!st) return { error: 'Unknown Eurostar station.' };
  const tz = st.tz || ez.tz;
  const ids = new Set([st.id, ...[...ez.stops.values()].filter((s) => s.parent === st.id).map((s) => s.id)]);
  const services = [];
  // trips on yesterday (after midnight), today and tomorrow, within 10 minutes ago .. 4 hours ahead
  for (const off of [-1, 0, 1]) {
    const ymd = ymdIn(now + off * 86400000, ez.tz);
    for (const [tripId, calls] of ez.times) {
      const trip = ez.trips.get(tripId);
      if (!trip || !runsOn(ez, trip.service, ymd)) continue;
      const i = calls.findIndex((c) => ids.has(c.stop));
      if (i < 0) continue;
      const last = i === calls.length - 1, first = i === 0;
      if (type === 'dep' && last) continue;
      if (type === 'arr' && first) continue;
      const rt = ez.rt.get(tripId + '|' + ymd) || null;
      const t = callTimes(ez, trip, ymd, calls[i], rt);
      const booked = type === 'arr' ? t.bArr : t.bDep, exp = type === 'arr' ? t.eArr : t.eDep;
      if (booked < now - 10 * 60000 || booked > now + 4 * 3600000) continue;
      const late = rt ? minsBetween(booked, exp) : null;
      const other = type === 'arr' ? calls[0] : calls[calls.length - 1];
      const id = `ez:${trip.num || tripId}:${ymd}`;
      ez.trainIds = ez.trainIds || new Map();
      ez.trainIds.set(id, { tripId, ymd });
      services.push({
        id, headcode: trip.num || null, booked: clockIn(booked, tz),
        // only "On time" when Eurostar's live feed covers the train
        expected: t.cancelled || t.skipped ? 'Cancelled' : !rt ? null : late > 0 ? clockIn(exp, tz) : 'On time',
        cancelled: t.cancelled || t.skipped, delay: rt ? late : null,
        place: (ez.stops.get(other.stop) && (ez.stops.get(ez.stops.get(other.stop).parent) || ez.stops.get(other.stop)).name) || trip.headsign,
        platform: null, toc: 'Eurostar', tocCode: null, next: null, reason: alertFor(ez, tripId, [...ids]), length: null, noLive: !rt, _t: booked
      });
    }
  }
  services.sort((a, b) => a._t - b._t);
  return { mode: 'live', source: 'eurostar', crs: code, name: st.name, type, services: services.map(({ _t, ...s }) => s), messages: [], credit: EZ_CREDIT };
}

// One train's calls with live times
export function ezTrain(ez, id) {
  const ref = ez.trainIds && ez.trainIds.get(id);
  if (!ref) return { error: 'Open this train from a Eurostar station board to see its stops.' };
  const trip = ez.trips.get(ref.tripId), calls = ez.times.get(ref.tripId) || [];
  const rt = ez.rt.get(ref.tripId + '|' + ref.ymd) || null;
  const now = Date.now();
  const stationOf = (stopId) => { const s = ez.stops.get(stopId); return s && s.parent && ez.stops.get(s.parent) ? ez.stops.get(s.parent) : s; };
  const stops = calls.map((c, i) => {
    const t = callTimes(ez, trip, ref.ymd, c, rt);
    const st = stationOf(c.stop) || {};
    const tz = st.tz || ez.tz;
    const first = i === 0;
    const booked = first ? t.bDep : t.bArr, exp = first ? t.eDep : t.eArr;
    const late = rt ? minsBetween(booked, exp) : null;
    return { name: st.name || c.stop, crs: st.id ? codeOf(st.id) : null, booked: clockIn(booked, tz), expected: exp && late ? clockIn(exp, tz) : null,
      cancelled: t.skipped, late, state: 'due', pass: false, platform: null };
  });
  const lates = stops.map((s) => s.late).filter((x) => x != null);
  return {
    mode: 'live', source: 'eurostar', natId: id, code: trip.num, operator: 'Eurostar', origin: stops[0] && stops[0].name, dest: stops.length ? stops[stops.length - 1].name : null,
    delay: lates.length ? Math.max(0, lates[lates.length - 1]) : null, cancelled: Boolean(rt && rt.cancelled), matched: true, stops, next: null, last: null,
    delayReason: alertFor(ez, ref.tripId, calls.map((c) => c.stop)),
    liveNote: rt ? 'Times from Eurostar, with its live changes. Each station shows its own local time. Eurostar doesn\'t publish where trains are, so stops aren\'t marked as passed.'
      : 'Eurostar timetable; its live feed has nothing for this train right now. Each station shows its own local time.'
  };
}
