// Design C, the route line, for any route you choose: a preset main line, a
// route you build station by station, or the stops of a train you tapped.
//
// Trains come from the same source as the map (api.trains). Each one is placed
// on the route by projecting its map position onto the line between the
// route's stations; a train more than a few km off the line is left out.
// Direction comes from the train's next (or last) reporting station, or from
// how it moved since the previous update.

import * as api from './api.js';
import { BY_CRS, km, searchStations } from './geo.js';
import { band } from './model.js';
import { loadList, saveList } from './ui.js';

const ROUTE_KEY = 'mtt.route';
const RECENT_KEY = 'mtt.routes.recent';
const SECTION_MEMORY_MS = 20 * 60 * 1000;

const preset = (id, name, codes) => ({ id, name, crs: codes.split(' ') });
export const PRESETS = [
  preset('ecml', 'East Coast Main Line', 'KGX SVG PBO GRA NNG RET DON YRK DAR DHM NCL BWK EDB'),
  preset('wcml', 'West Coast Main Line', 'EUS WFJ MKC RUG NUN TAM LTV STA CRE WBQ WGN PRE LAN OXN PNR CAR GLC'),
  preset('mml', 'Midland Main Line', 'STP LUT BDM WEL KET MHR LEI LBO EMD DBY CHD SHF'),
  preset('gwml', 'Great Western Main Line', 'PAD RDG DID SWI CPM BTH BRI'),
  preset('bml', 'Brighton Main Line', 'VIC CLJ ECR GTW HHE BTN'),
  preset('yrk-lds', 'York – Leeds', 'YRK ULL CHF MIK GRF CRG LDS'),
  preset('yrk-sca', 'York – Scarborough', 'YRK MLT SEM SCA')
];

// A route is { id, name, crs: [...] } with at least two stations the app knows
export function cleanRoute(r) {
  if (!r || !Array.isArray(r.crs)) return null;
  const crs = r.crs.filter((c, i) => BY_CRS.has(c) && c !== r.crs[i - 1]);
  if (crs.length < 2) return null;
  return { id: r.id || crs.join('-'), name: r.name || nameFor(crs), crs };
}
export const nameFor = (crs) => `${BY_CRS.get(crs[0]).name} – ${BY_CRS.get(crs[crs.length - 1]).name}`;

export function currentRoute() {
  try { return cleanRoute(JSON.parse(localStorage.getItem(ROUTE_KEY) || 'null')) || PRESETS[4]; } catch { return PRESETS[4]; }
}
export function setRoute(r) {
  const c = cleanRoute(r);
  if (!c) return null;
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify(c)); } catch { /* not saved */ }
  if (!PRESETS.some((p) => p.id === c.id)) {
    const recent = loadList(RECENT_KEY).filter((x) => x.id !== c.id);
    recent.unshift(c);
    saveList(RECENT_KEY, recent.slice(0, 6));
  }
  state.memory.clear(); state.prev.clear(); state.trains = []; state.at = 0;
  return c;
}
export const recentRoutes = () => loadList(RECENT_KEY).map(cleanRoute).filter(Boolean);

// Turn a train's stops into a route (station stops only, in order)
export function routeFromStops(stops, label) {
  const crs = [];
  for (const s of stops || []) {
    if (s.pass) continue;
    let c = s.crs && BY_CRS.has(s.crs) ? s.crs : null;
    if (!c && s.name) { const hit = searchStations(s.name, 1)[0]; if (hit && hit.name.toLowerCase() === s.name.toLowerCase()) c = hit.crs; }
    if (c && c !== crs[crs.length - 1]) crs.push(c);
  }
  if (crs.length < 2) return null;
  return { id: 'train-' + crs.join('-'), name: label || nameFor(crs), crs };
}

// ---- placing trains on the line ----
// Flat x/y in km around the route, good enough over a few hundred km
function projector(stations) {
  const lat0 = stations.reduce((s, p) => s + p.lat, 0) / stations.length;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
  return (lat, lon) => ({ x: lon * kx, y: lat * ky });
}

export function place(route, trains, prev = new Map()) {
  const st = route.crs.map((c) => BY_CRS.get(c));
  const xy = projector(st);
  const pts = st.map((s) => xy(s.lat, s.lon));
  const idx = new Map(route.crs.map((c, i) => [c, i]));
  const out = [];
  for (const t of trains) {
    if (t.lat == null) continue;
    const p = xy(t.lat, t.lon);
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const d = Math.hypot(p.x - (a.x + f * dx), p.y - (a.y + f * dy));
      const allow = Math.min(8, 2.5 + 0.08 * Math.sqrt(len2));
      if (d <= allow && (!best || d < best.d)) best = { pos: i + f, d };
    }
    const onRoute = idx.has(t.nextCrs) || idx.has(t.lastCrs);
    if (!best || (best.d > 4 && !onRoute)) continue;
    const pos = best.pos;
    let dir = null;
    if (idx.has(t.nextCrs) && Math.abs(idx.get(t.nextCrs) - pos) > 0.02) dir = idx.get(t.nextCrs) > pos ? 'down' : 'up';
    else if (idx.has(t.lastCrs) && Math.abs(idx.get(t.lastCrs) - pos) > 0.02) dir = idx.get(t.lastCrs) < pos ? 'down' : 'up';
    else if (prev.has(t.id) && Math.abs(prev.get(t.id).pos - pos) > 0.01) dir = pos > prev.get(t.id).pos ? 'down' : 'up';
    else if (prev.has(t.id)) dir = prev.get(t.id).dir;
    out.push({ id: t.id, code: t.code, toc: t.toc, dest: t.dest, delay: t.delay, cancelled: !!t.cancelled, band: band(t), pos, dir: dir || 'down', guessed: !dir, last: t.last });
  }
  return out;
}

// Boxes around each few stations, so a long route is fetched in pieces
// (one huge box would hit the 600-train limit when zoomed out)
export function boxesFor(route, perBox = 3) {
  const st = route.crs.map((c) => BY_CRS.get(c));
  const boxes = [];
  for (let i = 0; i < st.length - 1; i += perBox) {
    const part = st.slice(i, i + perBox + 1);
    const lats = part.map((s) => s.lat), lons = part.map((s) => s.lon);
    const m = 0.08;
    boxes.push({ s: Math.min(...lats) - m, n: Math.max(...lats) + m, w: Math.min(...lons) - m * 1.6, e: Math.max(...lons) + m * 1.6 });
  }
  return boxes;
}

// ---- the live route picture ----
const state = { trains: [], memory: new Map(), prev: new Map(), at: 0, mode: null, busy: false };

export async function refresh(route) {
  if (state.busy) return null;
  state.busy = true;
  try {
    const res = await Promise.all(boxesFor(route).map((b) => api.trains(b).catch(() => null)));
    const seen = new Map();
    let mode = null;
    for (const r of res) if (r && r.trains) { mode = r.mode; for (const t of r.trains) seen.set(t.id, t); }
    if (!mode) return null;
    state.trains = place(route, [...seen.values()], state.prev);
    state.prev = new Map(state.trains.map((t) => [t.id, { pos: t.pos, dir: t.dir }]));
    state.mode = mode;
    state.at = Date.now();
    return summarise(route);
  } finally { state.busy = false; }
}

export function summarise(route, now = Date.now()) {
  const n = route.crs.length;
  const trains = state.trains;
  const sections = {};
  for (const dir of ['down', 'up']) {
    sections[dir] = [];
    for (let i = 0; i < n - 1; i++) {
      const inside = trains.filter((t) => t.dir === dir && t.pos >= i && t.pos < i + 1 && t.delay != null);
      const key = dir + i;
      let delay = null;
      if (inside.length) { delay = Math.max(...inside.map((t) => t.delay)); state.memory.set(key, { delay, at: now }); }
      else { const h = state.memory.get(key); if (h && now - h.at < SECTION_MEMORY_MS) delay = h.delay; }
      sections[dir].push({ delay, band: band(delay == null ? null : { delay }), count: trains.filter((t) => t.dir === dir && t.pos >= i && t.pos < i + 1).length });
    }
  }
  const known = trains.filter((t) => t.delay != null);
  const avg = known.length ? Math.round(known.reduce((s, t) => s + Math.max(0, t.delay), 0) / known.length) : null;
  const lateCount = trains.filter((t) => t.cancelled || t.delay >= 2).length;
  const worst = [...known].sort((a, b) => b.delay - a.delay)[0] || null;
  return {
    id: route.id, name: route.name, mode: state.mode, updated: state.at,
    stations: route.crs.map((c) => BY_CRS.get(c).name), crs: route.crs,
    trains, sections, summary: { avg, lateCount, total: trains.length, worst }
  };
}

export const routeKm = (route) => {
  let d = 0;
  for (let i = 1; i < route.crs.length; i++) { const a = BY_CRS.get(route.crs[i - 1]), b = BY_CRS.get(route.crs[i]); d += km(a.lat, a.lon, b.lat, b.lon); }
  return Math.round(d);
};
