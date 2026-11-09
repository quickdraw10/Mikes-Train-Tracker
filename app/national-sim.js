// Demo trains for the whole country: invented services running between
// neighbouring stations, plus invented departure boards and a movement log.
// It answers the same three questions the live data service does:
//   trains(box)        trains on the map inside a box
//   board(crs, type)   departures or arrivals at a station
//   moves(lat, lon, r) recent movements within r km

import { STATIONS } from './stations.js';
import { BY_CRS, km, inBox } from './geo.js';
import { band } from './model.js';

const TOCS = ['East Midlands Railway', 'CrossCountry', 'Northern', 'Avanti West Coast', 'LNER', 'GWR', 'Southern', 'Thameslink', 'ScotRail', 'Transport for Wales', 'TransPennine Express', 'West Midlands Trains', 'Greater Anglia', 'Southeastern', 'South Western Railway', 'c2c', 'Chiltern Railways'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function randomDelay() {
  const r = Math.random();
  if (r < 0.62) return Math.random() < 0.5 ? 0 : 1;
  if (r < 0.9) return 2 + Math.floor(Math.random() * 8);
  return 10 + Math.floor(Math.random() * 25);
}

export function createNationalSim(count = 900) {
  // Each station's nearest neighbours within 30 km form a rough network
  const pts = STATIONS.map(([crs, name, lat, lon]) => ({ crs, name, lat, lon }));
  const grid = new Map();
  const cell = (lat, lon) => Math.floor(lat * 4) + ':' + Math.floor(lon * 3);
  for (const p of pts) { const k = cell(p.lat, p.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  const near = new Map();
  for (const p of pts) {
    const cand = [];
    const a = Math.floor(p.lat * 4), b = Math.floor(p.lon * 3);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get((a + i) + ':' + (b + j)) || []) {
      if (q !== p) cand.push({ q, d: km(p.lat, p.lon, q.lat, q.lon) });
    }
    near.set(p.crs, cand.filter((c) => c.d > 1 && c.d < 30).sort((x, y) => x.d - y.d).slice(0, 4).map((c) => c.q));
  }

  const used = new Set();
  const code = () => { let c; do { c = pick('12459') + pick('ABCDEFGHJKLMNOPRSTUVWXZ') + String(Math.floor(Math.random() * 100)).padStart(2, '0'); } while (used.has(c)); used.add(c); return c; };
  const trains = [];
  const log = [];

  function route(start) {
    let p = start || pick(pts);
    const path = [p];
    for (let i = 0; i < 7; i++) {
      const opts = (near.get(p.crs) || []).filter((q) => !path.includes(q));
      if (!opts.length) break;
      p = pick(opts);
      path.push(p);
    }
    return path.length >= 3 ? path : null;
  }

  function spawn(now, warm, start) {
    const path = route(start);
    if (!path) return;
    const t = { code: code(), toc: pick(TOCS), delay: randomDelay(), path, leg: 0, legStart: now, dwell: false, cancelled: false };
    t.legMins = legMins(t);
    if (warm === 'near') {
      t.legStart = now - Math.random() * 0.6 * t.legMins * 60000; // just leaving its first station
    } else if (warm) {
      t.leg = Math.floor(Math.random() * (path.length - 1));
      t.legStart = now - Math.random() * t.legMins * 60000;
    }
    trains.push(t);
  }
  function legMins(t) {
    const a = t.path[t.leg], b = t.path[t.leg + 1];
    return Math.max(2, km(a.lat, a.lon, b.lat, b.lon) / 1.3);
  }
  function note(t, stn, event, now) {
    log.push({ at: now, id: t.code, crs: stn.crs, name: stn.name, lat: stn.lat, lon: stn.lon, code: t.code, toc: t.toc, event, delay: t.delay, dest: t.path[t.path.length - 1].name });
    if (log.length > 4000) log.splice(0, log.length - 4000);
  }

  function tick(now = Date.now()) {
    for (const t of [...trains]) {
      const elapsed = (now - t.legStart) / 60000;
      if (elapsed >= t.legMins) {
        const arrived = t.path[t.leg + 1];
        note(t, arrived, t.leg + 1 === t.path.length - 1 ? 'Arrived (terminates)' : 'Arrived', now);
        if (Math.random() < 0.1) t.delay += 1 + Math.floor(Math.random() * 3);
        t.leg++;
        if (t.leg >= t.path.length - 1) { trains.splice(trains.indexOf(t), 1); used.delete(t.code); continue; }
        note(t, arrived, 'Departed', now);
        t.legStart = now;
        t.legMins = legMins(t);
      }
    }
    while (trains.length < count) spawn(now, false);
  }

  function position(t, now) {
    const a = t.path[t.leg], b = t.path[t.leg + 1];
    const f = Math.min(1, (now - t.legStart) / (t.legMins * 60000));
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, from: a, to: b };
  }

  function view(t, now) {
    const p = position(t, now);
    return {
      id: t.code, code: t.code, toc: t.toc, delay: t.delay, cancelled: t.cancelled, band: band(t),
      lat: p.lat, lon: p.lon, last: p.from.name, lastCrs: p.from.crs, lastEvent: 'Departed', next: p.to.name, nextCrs: p.to.crs,
      origin: t.path[0].name, dest: t.path[t.path.length - 1].name
    };
  }

  // A few hundred demo trains spread over 2,600 stations leaves most towns empty,
  // so when you look at (or watch) a quiet area, start some extra trains there.
  function liven(box, now, want = 12) {
    let have = 0;
    for (const t of trains) { const v = position(t, now); if (inBox(v.lat, v.lon, box)) have++; }
    if (have >= want || trains.length > count * 3) return;
    const local = pts.filter((p) => inBox(p.lat, p.lon, box));
    if (!local.length) return;
    for (let i = have; i < want; i++) spawn(now, 'near', pick(local));
  }

  // Train screen details in the same shape as the live service's /api/train/:id
  function train(id, now = Date.now()) {
    const t = trains.find((x) => x.code === id);
    if (!t) return { error: 'This train is no longer being tracked.' };
    const hm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    // Booked times: work back from the current leg using each leg's running time
    const times = [];
    let at = t.legStart - t.delay * 60000;
    times[t.leg] = at;
    for (let i = t.leg - 1; i >= 0; i--) { const a = t.path[i], b = t.path[i + 1]; at -= Math.max(2, km(a.lat, a.lon, b.lat, b.lon) / 1.3) * 60000 + 60000; times[i] = at; }
    at = times[t.leg];
    for (let i = t.leg + 1; i < t.path.length; i++) { const a = t.path[i - 1], b = t.path[i]; at += Math.max(2, km(a.lat, a.lon, b.lat, b.lon) / 1.3) * 60000 + (i > t.leg + 1 ? 60000 : 0); times[i] = at; }
    const stops = t.path.map((p, i) => {
      const passed = i <= t.leg;
      return { name: p.name, crs: p.crs, booked: hm(times[i]), platform: String(1 + (p.crs.charCodeAt(0) + i) % 6), state: passed ? 'passed' : 'due',
        actual: passed ? times[i] + t.delay * 60000 : null, expected: passed ? null : hm(times[i] + t.delay * 60000) };
    });
    // Show off the live features: a fast train passes some stations, and the odd stop is cancelled
    const fast = t.code[0] === '1';
    stops.forEach((s, i) => {
      if (fast && i > 0 && i < stops.length - 1 && i % 2 === 0) { s.pass = true; s.working = s.booked; s.platform = null; }
      if (!s.pass && s.state === 'due' && i === stops.length - 2 && t.delay >= 10) s.cancelled = true;
    });
    const next = stops.find((s, i) => i > t.leg && !s.pass && !s.cancelled) || null;
    return {
      mode: 'demo', source: 'darwin', length: 4 + (t.code.charCodeAt(3) % 3) * 2,
      delayReason: t.delay >= 5 ? 'This train has been delayed by a fault with the signalling system' : null,
      id: t.code, code: t.code, delay: t.delay, cancelled: t.cancelled, operator: t.toc, matched: true, passenger: true,
      origin: t.path[0].name, dest: t.path[t.path.length - 1].name, next, stops,
      last: { name: t.path[t.leg].name, event: 'Departed', at: times[t.leg] + t.delay * 60000 },
      path: t.path.slice(0, t.leg + 1).map((p, i) => ({ name: p.name, crs: p.crs, lat: p.lat, lon: p.lon, at: times[i] + t.delay * 60000 }))
    };
  }

  function trainsIn(box, now = Date.now()) {
    if ((box.e - box.w) < 1.5) liven(box, now);
    const out = [];
    for (const t of trains) { const v = view(t, now); if (inBox(v.lat, v.lon, box)) out.push(v); }
    return { mode: 'demo', total: out.length, trains: out.slice(0, 600) };
  }

  function board(crs, type = 'dep', now = Date.now()) {
    const st = BY_CRS.get(crs);
    if (!st) return { error: 'Unknown station' };
    const nb = near.get(crs) || [];
    const services = [];
    let t0 = now - 2 * 60000;
    for (let i = 0; i < 12; i++) {
      t0 += (3 + Math.random() * 9) * 60000;
      const delay = randomDelay();
      const far = (nb.length ? (near.get(pick(nb).crs) || []).concat(nb) : []).filter((q) => q.crs !== crs);
      const other = far.length ? pick(far) : st;
      const cancelled = Math.random() < 0.03;
      const time = new Date(t0);
      const hhmm = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
      const exp = new Date(t0 + delay * 60000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
      services.push({
        id: crs + i, booked: hhmm, expected: cancelled ? 'Cancelled' : delay >= 1 ? exp : 'On time', delay: cancelled ? null : delay, cancelled,
        place: other.name, platform: String(1 + Math.floor(Math.random() * 6)), toc: pick(TOCS),
        reason: cancelled ? 'This train has been cancelled because of a shortage of train crew' : delay >= 10 ? 'This train has been delayed by a fault with the signalling system' : null
      });
    }
    return { mode: 'demo', crs, name: st.name, type, services };
  }

  function moves(lat, lon, radius = 15, now = Date.now()) {
    const dLat = radius / 111, dLon = radius / (111 * Math.cos(lat * Math.PI / 180));
    liven({ w: lon - dLon, e: lon + dLon, s: lat - dLat, n: lat + dLat }, now);
    const out = [];
    for (let i = log.length - 1; i >= 0 && out.length < 80; i--) {
      const m = log[i];
      if (now - m.at > 60 * 60000) break;
      if (km(lat, lon, m.lat, m.lon) <= radius) out.push(m);
    }
    return { mode: 'demo', moves: out };
  }

  // Start 20 minutes ago and run forward, so the movement log has some history
  const start = Date.now() - 20 * 60000;
  for (let i = 0; i < count; i++) spawn(start, true);
  for (let s = 0; s <= 20; s++) tick(start + s * 60000);
  return { tick, trains: trainsIn, board, moves, train };
}
