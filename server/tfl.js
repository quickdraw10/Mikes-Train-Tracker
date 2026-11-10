// London: Transport for London's Unified API (api.tfl.gov.uk). Free; works without a key at
// low volumes, and with TFL_KEY (from api-portal.tfl.gov.uk) at higher ones.
//
// Covers the Tube, DLR and London Trams with live predictions, and line status for those plus
// the Overground and Elizabeth line (whose trains are already in Network Rail's data).
//
// Positions: TfL gives each train's predictions and a "current location" line such as
// "At Baker Street", "Between Bond Street and Oxford Circus" or "Approaching Victoria".
// A train is drawn at that station, or halfway between the two stations it is between; a
// train whose location TfL doesn't give, or whose train number is missing, isn't drawn.
// The Tube isn't timetabled train by train, so there is no "minutes late", only predictions.

const BASE = 'https://api.tfl.gov.uk';
export const TFL_LINES = {
  bakerloo: { name: 'Bakerloo', short: 'BAK', color: '#B36305' },
  central: { name: 'Central', short: 'CEN', color: '#E32017' },
  circle: { name: 'Circle', short: 'CIR', color: '#FFD300' },
  district: { name: 'District', short: 'DIS', color: '#00782A' },
  'hammersmith-city': { name: 'Hammersmith & City', short: 'H&C', color: '#F3A9BB' },
  jubilee: { name: 'Jubilee', short: 'JUB', color: '#A0A5A9' },
  metropolitan: { name: 'Metropolitan', short: 'MET', color: '#9B0056' },
  northern: { name: 'Northern', short: 'NOR', color: '#000000' },
  piccadilly: { name: 'Piccadilly', short: 'PIC', color: '#003688' },
  victoria: { name: 'Victoria', short: 'VIC', color: '#0098D4' },
  'waterloo-city': { name: 'Waterloo & City', short: 'W&C', color: '#95CDBA' },
  dlr: { name: 'DLR', short: 'DLR', color: '#00A4A7' },
  tram: { name: 'Trams', short: 'TRM', color: '#84B817' }
};
const STATUS_MODES = 'tube,dlr,overground,elizabeth-line,tram';

// Trackernet (Tube only): TfL's operational feed, with every train by its set number.
// Needs TFL_KEY. Line codes from TfL's Trackernet guide; H covers Hammersmith & City and Circle.
const TRACKERNET = { bakerloo: 'B', central: 'C', district: 'D', 'hammersmith-city': 'H', jubilee: 'J', metropolitan: 'M', northern: 'N', piccadilly: 'P', victoria: 'V', 'waterloo-city': 'W' };

async function getText(path) {
  const key = process.env.TFL_KEY;
  const res = await fetch(`${BASE}${path}`, { headers: { 'user-agent': 'MikesTrainTracker/1.0', ...(key ? { app_key: key } : {}) }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TfL returned ${res.status}`);
  return res.text();
}

// <S Code="BNK" N="Bank."><P N="Westbound - Platform 1" Code="0"><T S="051" T="12" D="..." C="2:30" L="Between X and Y" DE="Ealing Broadway"/></P></S>
export function parseSummary(xml) {
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"')]));
  const out = [];
  let station = null, platform = null;
  for (const m of xml.matchAll(/<(S|P|T)\b([^>]*)>/g)) {
    const a = attrs(m[2]);
    if (m[1] === 'S') station = { code: a.Code, name: (a.N || '').replace(/\.$/, '') };
    else if (m[1] === 'P') platform = a.N || null;
    else if (station) {
      const [mm, ss] = (a.C || '').split(':').map(Number);
      out.push({ set: a.S, trip: a.T, station: station.name, stationCode: station.code, platform, secs: a.C === '-' ? 0 : (mm || 0) * 60 + (ss || 0), location: a.L || '', dest: a.DE || null });
    }
  }
  return out;
}

async function get(path) {
  const key = process.env.TFL_KEY;
  const url = `${BASE}${path}${key ? (path.includes('?') ? '&' : '?') + 'app_key=' + encodeURIComponent(key) : ''}`;
  const res = await fetch(url, { headers: { 'user-agent': 'MikesTrainTracker/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TfL returned ${res.status}`);
  return res.json();
}

// "Baker Street Underground Station" -> "Baker Street"; used for names and for matching
export const tidy = (s) => String(s || '').replace(/\s+(Underground|DLR|Tram)\s+(Station|Stop)$/i, '').replace(/\s+(Station|Stop)$/i, '').trim();
const key = (s) => tidy(s).toLowerCase().replace(/&/g, 'and').replace(/['.()]/g, '').replace(/\s+/g, ' ').replace(/\bst\b/g, 'street').trim();

export function createTfl() {
  return { stations: new Map(), byLine: new Map(), trains: new Map(), status: [], at: 0, error: null };
}

// Stations for each line, with positions (once a day)
export async function loadTflStations(tfl) {
  for (const [id, line] of Object.entries(TFL_LINES)) {
    try {
      const pts = await get(`/Line/${id}/StopPoints`);
      const names = new Map();
      for (const p of pts) {
        const code = p.naptanId || p.id;
        if (!code || !p.lat || !p.lon) continue;
        const name = tidy(p.commonName);
        names.set(key(p.commonName), { lat: p.lat, lon: p.lon, name, code });
        const st = tfl.stations.get(code) || { crs: code, name: `${name} (${id === 'dlr' ? 'DLR' : id === 'tram' ? 'Tram' : 'Underground'})`, lat: p.lat, lon: p.lon, country: 'tfl', lines: [] };
        if (!st.lines.includes(id)) st.lines.push(id);
        tfl.stations.set(code, st);
      }
      tfl.byLine.set(id, names);
    } catch (e) { tfl.error = `${line.name}: ${e.message}`; }
  }
  return tfl.stations.size;
}

// Where a train is, from TfL's "current location" text, matched to that line's stations.
// Returns { lat, lon, text } or null when it can't be placed from what TfL says.
export function placeFromText(text, names, nextName) {
  const t = String(text || '').trim();
  if (!t) return null;
  const find = (n) => names.get(key(n)) || null;
  let m;
  if ((m = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(t))) {
    const a = find(m[1]), b = find(m[2]);
    if (a && b) return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2, text: t };
    return null;
  }
  if ((m = /^(?:left|departed|departing)\s+(.+)$/i.exec(t))) {
    const a = find(m[1]), b = nextName ? find(nextName) : null;
    if (a && b) return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2, text: t };
    return a ? { lat: a.lat, lon: a.lon, text: t } : null;
  }
  if ((m = /^(?:at|approaching|arriving at|near|in)\s+(.+?)(?:\s+platform\s*\w+)?$/i.exec(t))) {
    const a = find(m[1]);
    return a ? { lat: a.lat, lon: a.lon, text: t } : null;
  }
  if ((m = /^(?:north|south|east|west)\s+of\s+(.+)$/i.exec(t))) {
    const a = find(m[1]);
    return a ? { lat: a.lat, lon: a.lon, text: t } : null;
  }
  return null;
}

// All predictions, line by line (TfL's own advice: per line, not per mode). With a key, Tube
// lines come from Trackernet, which names every train by its set number; DLR and trams, and
// any Tube line Trackernet can't give, come from the Unified API's arrivals.
export async function pollTfl(tfl, now = Date.now()) {
  const trains = new Map();
  const viaTrackernet = new Set();
  if (process.env.TFL_KEY) {
    for (const [id, code] of Object.entries(TRACKERNET)) {
      if (id === 'hammersmith-city' && viaTrackernet.has('circle')) continue;
      let rows;
      try { rows = parseSummary(await getText(`/TrackerNet/PredictionSummary/${code}`)); } catch (e) { tfl.error = `Trackernet ${code}: ${e.message}`; continue; }
      if (!rows.length) continue;
      viaTrackernet.add(id);
      if (code === 'H') viaTrackernet.add('circle');
      const names = new Map([...(tfl.byLine.get(id) || new Map()), ...(code === 'H' ? tfl.byLine.get('circle') || new Map() : [])]);
      const bySet = new Map();
      for (const r of rows) if (r.set && !/^0+$/.test(r.set)) (bySet.get(r.set) || bySet.set(r.set, []).get(r.set)).push(r);
      const line = code === 'H' ? { name: 'H&C / Circle', short: 'H&C', color: TFL_LINES['hammersmith-city'].color } : TFL_LINES[id];
      for (const [set, list] of bySet) {
        list.sort((a, b) => a.secs - b.secs);
        const next = list[0];
        const pos = placeFromText(next.location, names, next.station);
        if (!pos) continue;
        const tid = `tfl:${id}:${set}`;
        trains.set(tid, { id: tid, line: id, vehicle: set, code: line.short, lineName: line.name, color: line.color, lat: pos.lat, lon: pos.lon, where: pos.text,
          dest: next.dest, next: next.station, nextIn: next.secs, platform: next.platform, updated: now, source: 'trackernet',
          stops: list.filter((r, i, all) => all.findIndex((x) => x.station === r.station) === i).map((r) => ({ name: r.station, secs: r.secs, platform: r.platform })) });
      }
    }
  }
  for (const id of Object.keys(TFL_LINES)) {
    if (viaTrackernet.has(id)) continue;
    let preds;
    try { preds = await get(`/Line/${id}/Arrivals`); } catch (e) { tfl.error = `${id}: ${e.message}`; continue; }
    const byVehicle = new Map();
    for (const p of preds) {
      const v = String(p.vehicleId || '').trim();
      if (!v || /^0+$/.test(v)) continue; // no train number: can't follow it
      (byVehicle.get(v) || byVehicle.set(v, []).get(v)).push(p);
    }
    const names = tfl.byLine.get(id) || new Map();
    for (const [v, list] of byVehicle) {
      list.sort((a, b) => a.timeToStation - b.timeToStation);
      const next = list[0];
      const pos = placeFromText(next.currentLocation, names, tidy(next.stationName));
      if (!pos) continue;
      const line = TFL_LINES[id];
      const tid = `tfl:${id}:${v}`;
      trains.set(tid, { id: tid, line: id, vehicle: v, code: line.short, lineName: line.name, color: line.color,
        lat: pos.lat, lon: pos.lon, where: pos.text, dest: tidy(next.destinationName) || next.towards || null,
        next: tidy(next.stationName), nextIn: next.timeToStation, platform: next.platformName || null, updated: now });
    }
  }
  tfl.trains = trains;
  tfl.at = now;
}

export async function pollTflStatus(tfl) {
  const lines = await get(`/Line/Mode/${STATUS_MODES}/Status`);
  tfl.status = lines.map((l) => {
    const s = (l.lineStatuses || [])[0] || {};
    return { id: l.id, name: l.name, mode: l.modeName, severity: s.statusSeverity ?? null, status: s.statusSeverityDescription || null, reason: s.reason || null,
      color: (TFL_LINES[l.id] || {}).color || (l.modeName === 'elizabeth-line' ? '#6950A1' : l.modeName === 'overground' ? '#EE7C0E' : null) };
  });
}

export function tflTrainsIn(tfl, box) {
  const out = [];
  for (const t of tfl.trains.values()) {
    if (t.lat < box.s || t.lat > box.n || t.lon < box.w || t.lon > box.e) continue;
    out.push({ id: t.id, code: t.code, lat: t.lat, lon: t.lon, delay: null, cancelled: false, color: t.color,
      toc: t.lineName, origin: null, dest: t.dest, last: t.where, lastEvent: null, next: t.next, country: 'tfl' });
  }
  return out;
}

const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const due = (s) => (s < 60 ? 'Due' : `${Math.round(s / 60)} min`);

// A station's next trains, in the boards' shape (TfL gives predictions, not timetabled times)
export async function tflBoard(tfl, code) {
  const preds = await get(`/StopPoint/${encodeURIComponent(code)}/Arrivals`);
  const st = tfl.stations.get(code);
  preds.sort((a, b) => a.timeToStation - b.timeToStation);
  const services = preds.slice(0, 30).map((p) => {
    const line = TFL_LINES[p.lineId] || { name: p.lineName };
    const v = String(p.vehicleId || '').trim();
    return { id: v && !/^0+$/.test(v) ? `tfl:${p.lineId}:${v}` : `tflp:${p.id}`, headcode: null, booked: clock(p.expectedArrival), expected: due(p.timeToStation),
      delay: null, cancelled: false, place: tidy(p.destinationName) || p.towards || 'Check front of train', platform: (/(\d+)\s*$/.exec(p.platformName || '') || [])[1] || null,
      toc: `${line.name}${p.platformName ? ' · ' + p.platformName : ''}`, tocCode: null, next: p.currentLocation || null, nextLabel: 'Now', reason: null, length: null };
  });
  const crowd = st && st.lines.some((l) => TRACKERNET[l]) ? await tflCrowding(code) : null;
  return { mode: 'live', source: 'tfl', crs: code, name: st ? st.name : tidy(preds[0] && preds[0].stationName) || code, services, messages: crowd ? [crowd] : [], predictions: true,
    credit: 'Powered by TfL Open Data' };
}

// One train's next stops, from TfL's predictions for that train
export async function tflTrain(tfl, id) {
  const [, line, vehicle] = id.split(':');
  const known = tfl.trains.get(id);
  if (known && known.stops && Date.now() - known.updated < 120000) {
    // Trackernet: this train's predicted stops from the last update
    const L = { name: known.lineName, short: known.code };
    const at = (secs) => clock(new Date(known.updated + secs * 1000).toISOString());
    const stops = known.stops.map((s) => ({ name: s.name, booked: null, expected: at(s.secs), state: 'due', pass: false, platform: (/(\d+)\s*$/.exec(s.platform || '') || [])[1] || null }));
    return { mode: 'live', source: 'tfl', natId: id, code: L.short, operator: `${L.name} line · train ${known.vehicle}`, origin: null, dest: known.dest, delay: null, cancelled: false, matched: true,
      stops, next: stops[0], last: { name: known.where, event: '', at: null },
      liveNote: 'Live predictions from TfL (Trackernet). The Tube has no timetable for each train, so there are no booked times or minutes late.' };
  }
  const preds = (await get(`/Line/${encodeURIComponent(line)}/Arrivals`)).filter((p) => String(p.vehicleId).trim() === vehicle);
  if (!preds.length) return { error: 'TfL has no predictions for this train right now.' };
  preds.sort((a, b) => a.timeToStation - b.timeToStation);
  const t = tfl.trains.get(id) || {};
  const L = TFL_LINES[line] || { name: line };
  const stops = preds.map((p) => ({ name: tidy(p.stationName), booked: null, expected: clock(p.expectedArrival), state: 'due', pass: false,
    platform: (/(\d+)\s*$/.exec(p.platformName || '') || [])[1] || null }));
  return { mode: 'live', source: 'tfl', natId: id, code: L.short, operator: `${L.name} line`, origin: null, dest: tidy(preds[0].destinationName) || preds[0].towards,
    delay: null, cancelled: false, matched: true, stops, next: stops[0], last: t.where ? { name: t.where, event: '', at: null } : null,
    liveNote: 'Live predictions from TfL. The Tube has no timetable for each train, so there are no booked times or minutes late.' };
}

// How busy a Tube station is right now, from TfL's live crowding data: a share of the
// busiest it has been. TfL's own wording: quiet below 0.4, busy to 0.7, very busy above.
export async function tflCrowding(code) {
  const once = async (withKey) => {
    const key = process.env.TFL_KEY;
    const res = await fetch(`${BASE}/crowding/${encodeURIComponent(code)}/Live${withKey && key ? '?app_key=' + encodeURIComponent(key) : ''}`, { signal: AbortSignal.timeout(8000) });
    return res.ok ? res.json() : null;
  };
  try {
    let d = await once(true);
    if (!d || !d.dataAvailable) d = await once(false); // TfL's forum reports the key sometimes breaks this call
    if (!d || !d.dataAvailable || typeof d.percentageOfBaseline !== 'number') return null;
    const p = d.percentageOfBaseline;
    const level = p < 0.4 ? 'Quiet' : p <= 0.7 ? 'Busy' : 'Very busy';
    return `How busy now: ${level} (${Math.round(p * 100)}% of its busiest) · TfL`;
  } catch { return null; }
}
