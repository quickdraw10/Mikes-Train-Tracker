// France: SNCF's own "API théorique et temps réel" (api.sncf.com, the Navitia engine). Needs a free
// key from SNCF's developer portal, kept in Railway as SNCF_KEY.
//
// What it gives: every SNCF station, live departure and arrival boards (TGV INOUI, OUIGO,
// Intercités, TER), each train's calls, and SNCF's own disruption messages with the cause.
//
// What it doesn't: where a train is. SNCF publishes no train positions (its GTFS-RT feed has
// trip updates only), so French trains are not drawn on the map. Stations and boards are.
//
// Station codes in the app are "FR" + the stop area's number (e.g. FR87686006, Paris Gare de Lyon);
// train ids are "fr:<train number>:<YYYYMMDD>", looked up from the boards they came from.

const BASE = 'https://api.sncf.com/v1/coverage/sncf';
export const FR_CREDIT = 'Live times: SNCF';

async function get(path) {
  const key = process.env.SNCF_KEY;
  if (!key) throw new Error('No SNCF key yet (SNCF_KEY in Railway)');
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'), 'user-agent': 'MikesTrainTracker/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`SNCF returned ${res.status}`);
  return res.json();
}

// "20261110T143000" (French local time) -> "14:30"; and minutes between two of them
export const hm = (s) => (/^\d{8}T(\d\d)(\d\d)/.exec(s || '') || []).slice(1).join(':') || null;
const mins = (s) => { const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null; };
export const lateBy = (base, real) => { const a = mins(base), b = mins(real); return a == null || b == null ? null : Math.round(b - a); };
const code = (stopAreaId) => 'FR' + String(stopAreaId || '').replace(/^stop_area:SNCF:/, '').replace(/\D/g, '');
const areaId = (frCode) => 'stop_area:SNCF:' + String(frCode).replace(/^FR/, '');

export function createFrance() {
  return { stations: new Map(), trains: new Map(), boards: new Map(), at: 0, error: null, calls: 0 };
}

// Every SNCF station with its position (about 3,000; a few pages)
export async function loadFrStations(fr) {
  let page = 0, total = Infinity;
  const found = new Map();
  while (page * 1000 < total && page < 10) {
    const r = await get(`/stop_areas?count=1000&start_page=${page}`);
    fr.calls++;
    total = (r.pagination && r.pagination.total_result) || 0;
    for (const s of r.stop_areas || []) {
      const lat = Number(s.coord && s.coord.lat), lon = Number(s.coord && s.coord.lon);
      if (!lat || !lon) continue;
      const c = code(s.id);
      found.set(c, { crs: c, name: s.name || s.label, lat, lon, country: 'fr' });
    }
    page++;
  }
  if (found.size) fr.stations = found;
  return fr.stations.size;
}

// SNCF's disruption for a train, if any: cancelled or late, with the cause in SNCF's words
function disruptionFor(disruptions, linkIds) {
  const ids = new Set(linkIds.filter(Boolean));
  return (disruptions || []).find((d) => ids.has(d.id) || ids.has(d.disruption_id)) || null;
}
const reasonOf = (d) => {
  if (!d) return null;
  const msg = (d.messages || []).map((m) => m.text).find(Boolean);
  const cause = d.cause || (d.impacted_objects || []).flatMap((o) => o.impacted_stops || []).map((s) => s.cause).find(Boolean);
  return [cause, msg && msg !== cause ? msg : null].filter(Boolean).join(' — ') || null;
};
const isCancelled = (d) => d && d.severity && /NO_SERVICE/i.test(d.severity.effect || '');

// A station board, in the boards' shape. Cached for 60 s so the free key's allowance goes further.
export async function frBoard(fr, frCode, type = 'dep') {
  const key = frCode + ':' + type;
  const hit = fr.boards.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.board;
  const what = type === 'arr' ? 'arrivals' : 'departures';
  const r = await get(`/stop_areas/${encodeURIComponent(areaId(frCode))}/${what}?data_freshness=realtime&count=40&duration=10800`);
  fr.calls++;
  const st = fr.stations.get(frCode);
  const list = r[what] || [];
  const services = list.map((x) => {
    const di = x.display_informations || {};
    const sdt = x.stop_date_time || {};
    const real = type === 'arr' ? sdt.arrival_date_time : sdt.departure_date_time;
    const base = type === 'arr' ? sdt.base_arrival_date_time : sdt.base_departure_date_time;
    const vj = (x.links || []).find((l) => l.type === 'vehicle_journey');
    const dis = disruptionFor(r.disruptions, (x.links || []).filter((l) => l.type === 'disruption').map((l) => l.id).concat(sdt.links ? sdt.links.filter((l) => l.type === 'disruption').map((l) => l.id) : []));
    const cancelled = isCancelled(dis);
    const live = sdt.data_freshness === 'realtime';
    const late = live && base ? lateBy(base, real) : null;
    const num = di.trip_short_name || di.headsign || '';
    const date = String(base || real || '').slice(0, 8);
    const id = `fr:${num}:${date}`;
    if (vj) fr.trains.set(id, { vj: vj.id, num, date, mode: di.commercial_mode || di.physical_mode || null, network: di.network || null, at: Date.now() });
    const bookedT = hm(base || real);
    return {
      id, headcode: num || null, booked: bookedT,
      // only say "On time" when SNCF's live data says so; otherwise "No live data"
      expected: cancelled ? 'Cancelled' : !live ? null : late > 0 ? hm(real) : 'On time',
      cancelled, delay: live ? late : null, place: di.direction ? di.direction.replace(/\s*\(.*?\)\s*$/, '') : '',
      platform: null, toc: [di.commercial_mode, di.network && di.network !== di.commercial_mode ? di.network : null].filter(Boolean).join(' · ') || 'SNCF', tocCode: null,
      next: null, reason: reasonOf(dis), length: null, noLive: !live
    };
  });
  // keep the train lookup from growing forever
  for (const [k, v] of fr.trains) if (Date.now() - v.at > 6 * 3600000) fr.trains.delete(k);
  const board = { mode: 'live', source: 'sncf', crs: frCode, name: st ? st.name : frCode, type, services, messages: [], credit: FR_CREDIT };
  fr.boards.set(key, { at: Date.now(), board });
  fr.at = Date.now();
  return board;
}

// One train's calls, with SNCF's live changes where it has them
export async function frTrain(fr, id) {
  const t = fr.trains.get(id);
  if (!t) return { error: 'Open this train from a French station board to see its stops.' };
  const r = await get(`/vehicle_journeys/${encodeURIComponent(t.vj)}`);
  fr.calls++;
  const vj = (r.vehicle_journeys || [])[0];
  if (!vj) return { error: 'SNCF has no details for this train.' };
  // live changes come as a disruption on the train: amended times per stop, or the stop cancelled
  const dis = (r.disruptions || [])[0] || null;
  const amended = new Map();
  for (const o of (dis && dis.impacted_objects) || []) for (const s of o.impacted_stops || []) {
    const sid = s.stop_point && s.stop_point.id;
    if (sid) amended.set(sid, s);
  }
  const now = Date.now();
  const stops = (vj.stop_times || []).map((s, i, all) => {
    const sp = s.stop_point || {};
    const a = amended.get(sp.id);
    const first = i === 0, last = i === all.length - 1;
    const baseT = first ? s.departure_time : s.arrival_time;
    const amT = a ? (first ? a.amended_departure_time : a.amended_arrival_time) : null;
    const booked = baseT ? `${baseT.slice(0, 2)}:${baseT.slice(2, 4)}` : null;
    const expected = amT && amT !== baseT ? `${amT.slice(0, 2)}:${amT.slice(2, 4)}` : null;
    const cancelled = a && /deleted|cancel/i.test(a.stop_time_effect || a.departure_status || '');
    return { name: (sp.name || '').replace(/\s*\(.*?\)\s*$/, ''), crs: sp.stop_area ? code(sp.stop_area.id) : null, booked, expected, cancelled,
      state: 'due', pass: false, platform: null, last };
  });
  // SNCF doesn't report when a train actually passed a station, so every stop shows its
  // booked time and SNCF's latest expected time; none is marked as passed.
  const late = dis ? Math.max(0, ...[...amended.values()].map((s) => { const b = s.base_arrival_time || s.base_departure_time, m = s.amended_arrival_time || s.amended_departure_time; if (!b || !m) return 0; return (Number(m.slice(0, 2)) * 60 + Number(m.slice(2, 4))) - (Number(b.slice(0, 2)) * 60 + Number(b.slice(2, 4))); })) : null;
  return {
    mode: 'live', source: 'sncf', natId: id, code: t.num, operator: t.mode || 'SNCF', origin: stops[0] && stops[0].name, dest: stops.length ? stops[stops.length - 1].name : null,
    delay: dis ? late : null, cancelled: isCancelled(dis), matched: true, stops, next: null, last: null, delayReason: reasonOf(dis),
    liveNote: dis ? 'Times from SNCF, with its latest changes for this train.' : 'SNCF timetable; SNCF reports no changes for this train. SNCF doesn\'t publish where trains are, so stops aren\'t marked as passed.'
  };
}
