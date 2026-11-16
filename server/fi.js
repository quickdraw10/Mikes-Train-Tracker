// Finland: Fintraffic's open rail data (digitraffic.fi), free, no key. Licence CC BY 4.0.
// Source: Fintraffic / digitraffic.fi
//
// This is the one national railway (besides Great Britain's own feeds) that publishes where its
// trains actually are: each train's own GPS unit reports every 6 seconds, and Fintraffic drops
// any fix more than 500 m from the track. Not every train has GPS switched on; a train without a
// recent fix simply isn't drawn. Times come from Finland's traffic control: the booked time, the
// actual time when the train got there, and traffic control's live estimate ahead.
//
// Station codes in the app: "FI" + Finland's own station code (e.g. FIHKI for Helsinki), with
// Ä/Ö/Å spelt AE/OE/AA so codes stay plain letters. Train ids: "fi:<departure date>:<number>".

const BASE = process.env.FI_RAIL_API || 'https://rata.digitraffic.fi/api/v1';
const HEADERS = { 'Digitraffic-User': 'MikesTrainTracker' };
export const FI_CREDIT = 'Source: Fintraffic / digitraffic.fi, licence CC BY 4.0';
export const FI_TZ = 'Europe/Helsinki';
const GPS_FRESH_MS = 3 * 60000; // GPS comes every 6 s; a fix older than 3 minutes isn't "where it is now"

async function get(path) {
  const res = await fetch(BASE + path, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Fintraffic returned ${res.status}`);
  return res.json();
}

export const appCode = (short) => 'FI' + String(short).toUpperCase().replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Å/g, 'AA').replace(/[^A-Z0-9]/g, '');
const tidy = (n) => String(n || '').replace(/ asema$/i, '').replace(/_/g, ' ').trim();
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: FI_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : null);
const keyOf = (date, num) => `${date}:${num}`;

export function createFinland() {
  return { stations: new Map(), byShort: new Map(), names: new Map(), operators: new Map(), trains: new Map(), gps: new Map(),
    version: 0, boards: new Map(), details: new Map(), at: 0, gpsAt: 0, stationsAt: 0, error: null, gpsError: null };
}

// ---- stations ----
export function setStations(fi, list) {
  fi.stations = new Map(); fi.byShort = new Map(); fi.names = new Map();
  for (const s of list || []) {
    fi.names.set(s.stationShortCode, tidy(s.stationName));
    if (!s.passengerTraffic || !Number.isFinite(s.latitude) || !Number.isFinite(s.longitude)) continue;
    const crs = appCode(s.stationShortCode);
    if (fi.stations.has(crs)) continue; // two codes spelling the same; keep the first
    fi.stations.set(crs, { crs, name: tidy(s.stationName), lat: s.latitude, lon: s.longitude, country: 'fi' });
    fi.byShort.set(crs, s.stationShortCode);
  }
  fi.stationsAt = Date.now();
  return fi.stations.size;
}
export async function loadFiStations(fi) {
  const [stations, ops] = await Promise.all([get('/metadata/stations'), get('/metadata/operators').catch(() => [])]);
  for (const o of ops || []) if (o.operatorShortCode) fi.operators.set(o.operatorShortCode, o.operatorName || o.operatorShortCode);
  return setStations(fi, stations);
}
const nameOf = (fi, short) => fi.names.get(short) || short;
const opName = (fi, code) => (code === 'vr' ? 'VR' : fi.operators.get(code) || (code ? code.toUpperCase() : null));

// ---- trains (live timetable with actual times) ----
// The train's own lateness: what traffic control recorded at the last place it actually got to.
// Before it has started there's no figure (not "on time").
export function summarise(fi, t) {
  const rows = t.timeTableRows || [];
  let lastI = -1;
  rows.forEach((r, i) => { if (r.actualTime) lastI = i; });
  const lastRow = lastI >= 0 ? rows[lastI] : null;
  const next = rows.slice(lastI + 1).find((r) => r.trainStopping && r.commercialStop !== false && r.type === 'ARRIVAL' && !r.cancelled) || null;
  const first = rows[0], end = rows[rows.length - 1];
  const label = t.commuterLineID ? `${t.commuterLineID} ${t.trainNumber}` : `${t.trainType || ''} ${t.trainNumber}`.trim();
  return {
    id: `fi:${t.departureDate}:${t.trainNumber}`, num: t.trainNumber, date: t.departureDate, label,
    toc: opName(fi, t.operatorShortCode), category: t.trainCategory || null, running: Boolean(t.runningCurrently), cancelled: Boolean(t.cancelled),
    origin: first ? nameOf(fi, first.stationShortCode) : null, dest: end ? nameOf(fi, end.stationShortCode) : null,
    delay: lastRow && Number.isFinite(lastRow.differenceInMinutes) ? lastRow.differenceInMinutes : null,
    unknownDelay: rows.some((r, i) => i > lastI && r.unknownDelay),
    last: lastRow ? nameOf(fi, lastRow.stationShortCode) : null, lastEvent: lastRow ? (lastRow.type === 'ARRIVAL' ? 'Arrived' : 'Departed') : null,
    lastAt: lastRow ? clock(lastRow.actualTime) : null,
    next: next ? nameOf(fi, next.stationShortCode) : null,
    endTime: end ? Date.parse(end.actualTime || end.liveEstimateTime || end.scheduledTime) : 0
  };
}
// track: only the all-trains poll moves the change number on (a board's trains mustn't skip changes to others)
export function applyTrains(fi, list, now = Date.now(), track = false) {
  for (const t of list || []) {
    if (!t || t.trainNumber == null) continue;
    if (track && t.version > fi.version) fi.version = t.version;
    const k = keyOf(t.departureDate, t.trainNumber);
    if (t.deleted) { fi.trains.delete(k); continue; }
    fi.trains.set(k, { raw: t, sum: summarise(fi, t) });
  }
  // forget trains that finished more than 4 hours ago
  for (const [k, v] of fi.trains) if (v.sum.endTime && v.sum.endTime < now - 4 * 3600000) fi.trains.delete(k);
  fi.at = now;
}
export async function pollFiTrains(fi) {
  const list = await get(fi.version ? `/live-trains?version=${fi.version}` : '/live-trains');
  applyTrains(fi, list, Date.now(), true);
  fi.error = null;
}

// ---- GPS ----
export function applyGps(fi, list, now = Date.now()) {
  const gps = new Map();
  for (const g of list || []) {
    const c = g.location && g.location.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const ts = Date.parse(g.timestamp);
    if (!ts || now - ts > GPS_FRESH_MS) continue;
    gps.set(keyOf(g.departureDate, g.trainNumber), { lat: c[1], lon: c[0], speed: Number.isFinite(g.speed) ? g.speed : null, accuracy: g.accuracy ?? null, ts, num: g.trainNumber, date: g.departureDate });
  }
  fi.gps = gps; fi.gpsAt = now; fi.gpsError = null;
}
export async function pollFiGps(fi) { applyGps(fi, await get('/train-locations/latest')); }

// In the map's shape: only trains with a fresh GPS fix
export function finnishTrainsIn(fi, box, now = Date.now()) {
  const out = [];
  for (const [k, g] of fi.gps) {
    if (now - g.ts > GPS_FRESH_MS) continue;
    if (g.lat < box.s || g.lat > box.n || g.lon < box.w || g.lon > box.e) continue;
    const s = (fi.trains.get(k) || {}).sum || null;
    out.push({ id: `fi:${g.date}:${g.num}`, code: s ? s.label : String(g.num), lat: g.lat, lon: g.lon,
      delay: s ? s.delay : null, cancelled: s ? s.cancelled : false, band: null, toc: s ? s.toc : null, tocCode: null,
      origin: s ? s.origin : null, dest: s ? s.dest : null, last: s ? s.last : null, lastEvent: s ? s.lastEvent : null, lastAt: s ? s.lastAt : null,
      next: s ? s.next : null, speed: g.speed, gpsAge: Math.round((now - g.ts) / 1000), country: 'fi' });
  }
  return out;
}

// ---- a station board ----
export function boardFrom(fi, code, type, trains, now = Date.now()) {
  const short = fi.byShort.get(code);
  const st = fi.stations.get(code);
  const want = type === 'arr' ? 'ARRIVAL' : 'DEPARTURE';
  const services = [];
  for (const t of trains || []) {
    const rows = t.timeTableRows || [];
    const i = rows.findIndex((r) => r.stationShortCode === short && r.type === want && r.trainStopping && r.commercialStop !== false);
    if (i < 0) continue;
    const r = rows[i];
    const booked = Date.parse(r.scheduledTime);
    const shown = Date.parse(r.actualTime || r.liveEstimateTime || r.scheduledTime);
    if (shown < now - 10 * 60000 || booked > now + 4 * 3600000) continue;
    const late = Number.isFinite(r.differenceInMinutes) ? r.differenceInMinutes : null;
    const live = Boolean(r.actualTime || r.liveEstimateTime);
    const other = type === 'arr' ? rows[0] : rows[rows.length - 1];
    const cancelled = Boolean(t.cancelled || r.cancelled);
    services.push({
      id: `fi:${t.departureDate}:${t.trainNumber}`, headcode: t.commuterLineID ? `${t.commuterLineID} ${t.trainNumber}` : `${t.trainType || ''} ${t.trainNumber}`.trim(),
      booked: clock(r.scheduledTime),
      // "On time" only when traffic control has a live time for this stop
      expected: cancelled ? 'Cancelled' : r.unknownDelay ? 'Delayed' : !live ? null : late > 0 ? clock(r.actualTime || r.liveEstimateTime) : 'On time',
      cancelled, delay: live ? late : null, place: other ? nameOf(fi, other.stationShortCode) : null,
      platform: r.commercialTrack || null, toc: opName(fi, t.operatorShortCode), tocCode: null, next: null, reason: null, length: null,
      noLive: !live, departed: Boolean(r.actualTime), _t: booked
    });
  }
  services.sort((a, b) => a._t - b._t);
  return { mode: 'live', source: 'fintraffic', crs: code, name: st ? st.name : code, type, services: services.map(({ _t, ...s }) => s), messages: [], credit: FI_CREDIT, timeNote: 'Finnish time' };
}
export async function fiBoard(fi, code, type = 'dep') {
  const short = fi.byShort.get(code);
  if (!short) return { error: 'Unknown Finnish station.' };
  const ck = code + '|' + type;
  const hit = fi.boards.get(ck);
  if (hit && Date.now() - hit.at < 30000) return hit.board;
  const q = type === 'arr' ? 'minutes_before_departure=0&minutes_after_departure=0&minutes_before_arrival=240&minutes_after_arrival=10'
    : 'minutes_before_departure=240&minutes_after_departure=10&minutes_before_arrival=0&minutes_after_arrival=0';
  const trains = await get(`/live-trains/station/${encodeURIComponent(short)}?${q}&include_nonstopping=false`);
  applyTrains(fi, trains);
  const board = boardFrom(fi, code, type, trains);
  fi.boards.set(ck, { at: Date.now(), board });
  return board;
}

// ---- one train's page ----
export function detailFrom(fi, t, gps, now = Date.now()) {
  const rows = t.timeTableRows || [];
  // pair each place's arrival and departure rows into one call
  const calls = [];
  rows.forEach((r) => {
    const prev = calls[calls.length - 1];
    if (prev && prev.short === r.stationShortCode && prev.dep == null && r.type === 'DEPARTURE') { prev.dep = r; return; }
    calls.push({ short: r.stationShortCode, arr: r.type === 'ARRIVAL' ? r : null, dep: r.type === 'DEPARTURE' ? r : null });
  });
  const stops = calls.map((c, i) => {
    const main = i === 0 ? c.dep || c.arr : c.arr || c.dep; // the time people look for: arrival, or departure at the start
    const stopping = (c.arr || c.dep).trainStopping;
    const commercial = stopping && (c.arr || c.dep).commercialStop !== false;
    const late = Number.isFinite(main.differenceInMinutes) ? main.differenceInMinutes : null;
    const crs = appCode(c.short);
    return {
      name: nameOf(fi, c.short), crs: fi.stations.has(crs) ? crs : null,
      booked: clock(main.scheduledTime), actual: clock(main.actualTime), expected: main.actualTime ? null : clock(main.liveEstimateTime),
      depBooked: c.arr && c.dep ? clock(c.dep.scheduledTime) : null, depActual: c.arr && c.dep ? clock(c.dep.actualTime) : null,
      state: c.dep ? (c.dep.actualTime ? 'passed' : 'due') : main.actualTime ? 'passed' : 'due',
      pass: !commercial, platform: main.commercialTrack || null, cancelled: Boolean(main.cancelled),
      late: main.actualTime || main.liveEstimateTime ? late : null, unknownDelay: Boolean(main.unknownDelay)
    };
  });
  const s = summarise(fi, t);
  const next = stops.find((x) => x.state === 'due' && !x.pass && !x.cancelled) || null;
  const lastPassed = [...stops].reverse().find((x) => x.state === 'passed');
  const g = gps && now - gps.ts <= GPS_FRESH_MS ? gps : null;
  return {
    mode: 'live', source: 'fintraffic', natId: s.id, code: s.label, operator: s.toc, origin: s.origin, dest: s.dest,
    delay: s.delay, cancelled: s.cancelled, matched: true, stops, next,
    terminated: Boolean(stops.length && stops[stops.length - 1].actual),
    last: lastPassed ? { name: lastPassed.name, event: lastPassed === stops[stops.length - 1] ? 'Arrived' : 'Passed', at: lastPassed.depActual || lastPassed.actual } : null,
    gps: g ? { lat: g.lat, lon: g.lon, speed: g.speed, ageSec: Math.round((now - g.ts) / 1000) } : null,
    delayReason: s.unknownDelay ? 'Traffic control says this train is delayed but can\'t yet say by how much.' : null,
    liveNote: `Live from Finland's traffic control (Fintraffic). Times are Finnish time; actual times are when the train got there.${g ? ` Map position is the train's own GPS, ${Math.round((now - g.ts) / 1000)} s ago${g.speed != null ? `, ${Math.round(g.speed)} km/h` : ''}.` : ' No GPS from this train in the last 3 minutes, so it isn\'t on the map.'}`,
    credit: FI_CREDIT
  };
}
export async function fiTrain(fi, id) {
  const [, date, num] = String(id).split(':');
  if (!/^\d{4}-\d\d-\d\d$/.test(date || '') || !/^\d{1,5}$/.test(num || '')) return { error: 'Unknown Finnish train.' };
  const k = keyOf(date, num);
  let hit = fi.details.get(k);
  if (!hit || Date.now() - hit.at > 30000) {
    const list = await get(`/trains/${date}/${num}`);
    const t = Array.isArray(list) ? list[0] : list;
    if (!t) return { error: 'Fintraffic has no details for this train.' };
    applyTrains(fi, [t]);
    hit = { at: Date.now(), t };
    fi.details.set(k, hit);
    if (fi.details.size > 300) fi.details.delete(fi.details.keys().next().value);
  }
  return detailFrom(fi, hit.t, fi.gps.get(k));
}
