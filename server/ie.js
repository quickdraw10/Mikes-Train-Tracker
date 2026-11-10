// Ireland: Irish Rail's public real-time service (api.irishrail.ie), free, no key.
// It gives every running train with a position and a public message ("… (3 mins late)"),
// station boards for the next 90 minutes, and each train's calls with actual times.
//
// Irish Rail's notes: times are estimates from its signalling and the timetable, and a few
// lines (e.g. Dundalk–Belfast, Mallow–Tralee) have scheduled times only. Where the service
// gives no live figure, the app shows "no live data" rather than "on time".
//
// Station codes are Irish Rail's own (e.g. CNLLY, PERSE), five letters, so they never clash
// with the three-letter National Rail codes; train ids are "ie:<code>:<date>".

const BASES = ['https://api.irishrail.ie/realtime/realtime.asmx', 'http://api.irishrail.ie/realtime/realtime.asmx'];
export const IE_OPERATOR = 'Iarnród Éireann';

// The service returns flat XML lists: <ArrayOfX><X><Field>value</Field>…</X>…</ArrayOfX>.
// Fields are read case-insensitively because the casing differs between calls.
export function parseList(xml, item) {
  const out = [];
  const re = new RegExp(`<${item}>([\\s\\S]*?)</${item}>`, 'gi');
  let m;
  while ((m = re.exec(xml))) {
    const rec = {};
    const f = /<([A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/g;
    let x;
    while ((x = f.exec(m[1]))) rec[x[1].toLowerCase()] = decode(x[2].trim());
    out.push(rec);
  }
  return out;
}
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function get(path) {
  let last;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(12000) });
      if (res.ok) return await res.text();
      last = new Error(`Irish Rail returned ${res.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}

const hm = (v) => { const m = /^(\d\d):(\d\d)/.exec(v || ''); return m && v !== '00:00' ? `${m[1]}:${m[2]}` : null; };
const cap = (s) => (s || '').toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (a, b, c) => b + c.toUpperCase());

// "AA509\n11:00 - Waterford to Dublin Heuston (0 mins late)\nDeparted Waterford next stop Thomastown"
export function parseMessage(msg) {
  const lines = String(msg || '').replace(/\\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { delay: null, origin: null, dest: null, start: null, status: lines[2] || null };
  const route = /^(\d\d:\d\d)\s*-\s*(.+?)\s+to\s+(.+?)\s*\((-?\d+)\s*mins?\s*(late|early)?\)/i.exec(lines[1] || '');
  if (route) {
    out.start = route[1]; out.origin = route[2]; out.dest = route[3];
    const n = Number(route[4]);
    out.delay = route[5] && /early/i.test(route[5]) ? -n : n;
  }
  const st = /^(Departed|Arrived)\s+(.+?)(?:\s+next stop\s+(.+))?$/i.exec(out.status || '');
  if (st) { out.event = cap(st[1]); out.last = st[2]; out.next = st[3] || null; }
  return out;
}

export function createIrish() {
  const ie = { trains: new Map(), stations: new Map(), at: 0, error: null, stationsAt: 0 };
  return ie;
}

export async function loadStations(ie) {
  const xml = await get('getAllStationsXML');
  for (const s of parseList(xml, 'objStation')) {
    const code = (s.stationcode || '').trim().toUpperCase();
    const lat = Number(s.stationlatitude), lon = Number(s.stationlongitude);
    if (!code || !lat || !lon) continue;
    ie.stations.set(code, { crs: code, name: s.stationdesc, lat, lon, country: 'ie' });
  }
  ie.stationsAt = Date.now();
  return ie.stations.size;
}

export async function pollTrains(ie, now = Date.now()) {
  const xml = await get('getCurrentTrainsXML');
  const seen = new Set();
  for (const r of parseList(xml, 'objTrainPositions')) {
    if ((r.trainstatus || '').toUpperCase() !== 'R') continue; // only trains actually running
    const lat = Number(r.trainlatitude), lon = Number(r.trainlongitude);
    if (!lat || !lon) continue;
    const code = (r.traincode || '').trim();
    const id = `ie:${code}:${(r.traindate || '').trim()}`;
    const msg = parseMessage(r.publicmessage);
    seen.add(id);
    ie.trains.set(id, { id, code, date: (r.traindate || '').trim(), lat, lon, delay: msg.delay, origin: msg.origin, dest: msg.dest,
      last: msg.last || null, lastEvent: msg.event || null, next: msg.next || null, direction: r.direction || null, updated: now });
  }
  for (const id of ie.trains.keys()) if (!seen.has(id)) ie.trains.delete(id);
  ie.at = now;
  ie.error = null;
}

// In the map's shape
export function irishTrainsIn(ie, box) {
  const out = [];
  for (const t of ie.trains.values()) {
    if (t.lat < box.s || t.lat > box.n || t.lon < box.w || t.lon > box.e) continue;
    out.push({ id: t.id, code: t.code, lat: t.lat, lon: t.lon, delay: t.delay, cancelled: false, band: null,
      toc: IE_OPERATOR, tocCode: null, origin: t.origin, dest: t.dest, last: t.last, lastEvent: t.lastEvent, next: t.next, country: 'ie' });
  }
  return out;
}

// A station board, in the boards' shape
export async function irishBoard(ie, code, type = 'dep') {
  const xml = await get(`getStationDataByCodeXML_WithNumMins?StationCode=${encodeURIComponent(code)}&NumMins=90`);
  const rows = parseList(xml, 'objStationData');
  const name = (rows[0] && rows[0].stationfullname) || (ie.stations.get(code) || {}).name || code;
  const services = rows.filter((r) => {
    const lt = (r.locationtype || '').toUpperCase();
    return type === 'arr' ? lt !== 'O' : lt !== 'D'; // departures: not trains ending here; arrivals: not trains starting here
  }).map((r) => {
    const booked = type === 'arr' ? hm(r.scharrival) : hm(r.schdepart);
    const exp = type === 'arr' ? hm(r.exparrival) : hm(r.expdepart);
    const late = r.late === '' || r.late == null ? null : Number(r.late);
    return {
      id: `ie:${r.traincode}:${r.traindate}`, headcode: r.traincode, booked, expected: late == null ? exp : late <= 0 ? 'On time' : exp,
      cancelled: /cancel/i.test(r.status || ''), delay: Number.isFinite(late) ? late : null,
      place: type === 'arr' ? r.origin : r.destination, platform: null, toc: IE_OPERATOR, tocCode: null,
      next: null, reason: null, length: null, lastSeen: r.lastlocation || null
    };
  }).filter((s) => s.booked).sort((a, b) => a.booked.localeCompare(b.booked));
  return { mode: 'live', source: 'irishrail', crs: code, name, type, services, messages: [], credit: 'Live times: Iarnród Éireann' };
}

// One train's calls, in the train screen's shape
export async function irishTrain(ie, id) {
  const [, code, date] = id.split(':');
  const xml = await get(`getTrainMovementsXML?TrainId=${encodeURIComponent(code)}&TrainDate=${encodeURIComponent(date)}`);
  const rows = parseList(xml, 'objTrainMovements').sort((a, b) => Number(a.locationorder) - Number(b.locationorder));
  if (!rows.length) return { error: 'Irish Rail has no details for this train.' };
  const t = ie.trains.get(id) || {};
  const stops = rows.filter((r) => (r.locationtype || '').toUpperCase() !== 'T').map((r) => {
    const booked = hm(r.scheduledarrival) || hm(r.scheduleddeparture);
    const actual = hm(r.arrival) || hm(r.departure);
    const expected = hm(r.expectedarrival) || hm(r.expecteddeparture);
    return { name: cap(r.locationfullname), code: r.locationcode, booked, actual, expected: actual ? null : expected,
      state: actual ? 'passed' : 'due', pass: false, platform: null, late: actual && booked ? lateMins(booked, actual) : null };
  });
  const passPts = rows.filter((r) => (r.locationtype || '').toUpperCase() === 'T').length;
  const next = stops.find((s) => s.state === 'due') || null;
  const lastPassed = [...stops].reverse().find((s) => s.state === 'passed');
  return {
    mode: 'live', source: 'irishrail', code, operator: IE_OPERATOR, origin: cap(rows[0].trainorigin), dest: cap(rows[0].traindestination),
    delay: t.delay ?? null, cancelled: false, matched: true, stops, next, passingPoints: passPts,
    last: lastPassed ? { name: lastPassed.name, event: 'Passed', at: null } : null,
    liveNote: 'Live from Iarnród Éireann (times are its estimates; some lines are timetable-only)'
  };
}

function lateMins(booked, actual) {
  const m = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  let d = m(actual) - m(booked);
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}
