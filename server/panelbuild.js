// Builds a signal-box panel for one station from Network Rail's SMART berth
// data: one road per platform, with the platform berths in the middle and
// the approach berths at each end.
//
// SMART EVENT codes (Open Rail Data wiki, SmartBerthDetail):
//   A arrive up, B depart up, C arrive down, D depart down.
// "Down" trains run away from London, so at York they arrive from the south
// (left of the panel) and leave to the north (right). "Up" is the reverse.
//
// Columns on each road, left to right:
//   0 outer south · 1-2 south approach · 3-4 platform · 5-6 north approach · 7 outer north

import zlib from 'node:zlib';

const URL_SMART = process.env.NR_SMART_URL || 'https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=SMART';
const SPECIAL = /^(COUT|STIN|CO\d\d|ST\d\d)$/;
const okBerth = (b) => typeof b === 'string' && /^[A-Z0-9]{4}$/.test(b.trim()) && !SPECIAL.test(b.trim());

export async function downloadSmart(user, pass) {
  const res = await fetch(URL_SMART, { headers: { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') }, redirect: 'follow' });
  if (!res.ok) throw new Error(`SMART download failed: ${res.status} ${res.statusText}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

const platOrder = (a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b);

// The rows for one station: by STANOX when we know it (works across TD areas,
// e.g. a station split between two signalling centres), else by area and SMART name.
function stationRows(smart, cfg) {
  const rows = smart.BERTHDATA || [];
  if (cfg.stanox && cfg.stanox.length) {
    const want = new Set(cfg.stanox.map(String));
    const here = rows.filter((r) => want.has(String(r.STANOX || '').trim()) && (r.PLATFORM || '').trim());
    if (here.length) return here;
  }
  if (!cfg.area || !cfg.stanme) return [];
  const inArea = rows.filter((r) => (r.TD || '').trim() === cfg.area);
  const want = cfg.stanme.toUpperCase();
  const exact = inArea.filter((r) => (r.STANME || '').trim().toUpperCase() === want);
  return exact.length ? exact : inArea.filter((r) => (r.STANME || '').trim().toUpperCase().startsWith(want));
}

export function buildStationPanel(smart, cfg) {
  const here = stationRows(smart, cfg);
  // Which TD areas the station's platforms are in, busiest first
  const count = {};
  for (const r of here) { const a = (r.TD || '').trim(); if (a) count[a] = (count[a] || 0) + 1; }
  const areas = Object.keys(count).sort((a, b) => count[b] - count[a]);
  const area = areas[0] || cfg.area || null;
  const inAreas = new Set(areas);
  const all = (smart.BERTHDATA || []).filter((r) => inAreas.has((r.TD || '').trim()));
  // Berths are named "area:berth" while building, so two areas' berth numbers can't clash
  const key = (r, b) => `${(r.TD || '').trim()}:${b}`;

  const plats = new Map();
  const P = (p) => { if (!plats.has(p)) plats.set(p, { plat: new Set(), south: new Set(), north: new Set() }); return plats.get(p); };
  for (const r of here) {
    const p = (r.PLATFORM || '').trim();
    if (!p) continue;
    const ev = (r.EVENT || '').trim();
    const from = (r.FROMBERTH || '').trim(), to = (r.TOBERTH || '').trim();
    const x = P(p);
    if (ev === 'A' || ev === 'C') {          // arriving: "to" is the platform
      if (okBerth(to)) x.plat.add(key(r, to));
      if (okBerth(from)) (ev === 'C' ? x.south : x.north).add(key(r, from));
    } else if (ev === 'B' || ev === 'D') {   // departing: "from" is the platform
      if (okBerth(from)) x.plat.add(key(r, from));
      if (okBerth(to)) (ev === 'B' ? x.south : x.north).add(key(r, to));
    }
  }

  // A berth that is a platform anywhere is not an approach berth
  const platformBerths = new Set([...plats.values()].flatMap((x) => [...x.plat]));
  for (const x of plats.values()) for (const side of ['south', 'north']) for (const b of x[side]) if (platformBerths.has(b)) x[side].delete(b);

  // One step further out, from the area's stepping table
  const edges = new Map();
  const link = (a, b) => { (edges.get(a) || edges.set(a, new Set()).get(a)).add(b); (edges.get(b) || edges.set(b, new Set()).get(b)).add(a); };
  const link2 = (r) => { const f = (r.FROMBERTH || '').trim(), t = (r.TOBERTH || '').trim(); if (okBerth(f) && okBerth(t)) link(key(r, f), key(r, t)); };
  for (const r of all) link2(r);
  // An approach berth used by several platforms is part of the main line, not one road:
  // it goes in the fringe (approaching / just left) so a train is never drawn twice.
  const uses = new Map();
  for (const x of plats.values()) for (const side of ['south', 'north']) for (const b of x[side]) uses.set(b, (uses.get(b) || 0) + 1);
  const shared = { south: new Set(), north: new Set() };
  for (const x of plats.values()) for (const side of ['south', 'north']) for (const b of [...x[side]]) if (uses.get(b) > 1) { x[side].delete(b); shared[side].add(b); }

  const used = new Set([...platformBerths, ...[...plats.values()].flatMap((x) => [...x.south, ...x.north])]);
  const outer = (set) => { for (const b of set) for (const n of edges.get(b) || []) if (!used.has(n) && !shared.south.has(n) && !shared.north.has(n)) return n; return null; };

  // Each slot on a road can stand for several berths, so a train in any of them shows
  const tracks = [...plats.keys()].sort(platOrder).map((p) => {
    const x = plats.get(p);
    const berths = [];
    const slot = (keys, col, kind) => {
      if (!keys.length) return;
      const [a, id] = keys[0].split(':');
      const b = { id, col, kind };
      if (a !== area) b.area = a;
      if (keys.length > 1) b.keys = keys;
      berths.push(b);
    };
    const halves = (list, cols) => { if (list.length <= 1) return slot(list, cols[0]); const h = Math.ceil(list.length / 2); slot(list.slice(0, h), cols[0]); slot(list.slice(h), cols[1]); };
    const so = outer(x.south), no = outer(x.north);
    if (so) { used.add(so); slot([so], 0, 'line'); }
    const south = [...x.south].sort().reverse(), north = [...x.north].sort(), plat = [...x.plat].sort();
    if (south.length) { slot([south[0]], 2, 'line'); slot(south.slice(1), 1, 'line'); }
    if (plat.length <= 1) slot(plat, 3, 'platform'); else { const h = Math.ceil(plat.length / 2); slot(plat.slice(0, h), 3, 'platform'); slot(plat.slice(h), 4, 'platform'); }
    if (north.length) { slot([north[0]], 5, 'line'); slot(north.slice(1), 6, 'line'); }
    if (no) { used.add(no); slot([no], 7, 'line'); }
    for (const b of berths) if (!b.kind) b.kind = 'line';
    return { name: p, berths };
  }).filter((t) => t.berths.some((b) => b.kind === 'platform'));

  // The fringe: every berth within a few steps of the station, with which end it is
  // at and how many steps out. Lets the app list trains approaching and just gone.
  const onPanel = new Set();
  for (const t of tracks) for (const b of t.berths) for (const k of b.keys || [`${b.area || area}:${b.id}`]) onPanel.add(k);
  const fringe = {};
  const seed = (side, keys, d) => { for (const k of keys) if (!onPanel.has(k)) { if (!fringe[k] || fringe[k][1] > d) fringe[k] = [side, d]; } };
  const southPanel = [], northPanel = [];
  for (const t of tracks) for (const b of t.berths) { const ks = b.keys || [`${b.area || area}:${b.id}`]; if (b.col <= 2) southPanel.push(...ks); if (b.col >= 5) northPanel.push(...ks); }
  seed(0, shared.south, 1); seed(1, shared.north, 1);
  for (const [side, from] of [[0, southPanel], [1, northPanel]]) for (const k of from) for (const n of edges.get(k) || []) seed(side, [n], 1);
  const MAX = 12;
  for (let d = 1; d < MAX; d++) {
    for (const [k, [side, dk]] of Object.entries(fringe)) {
      if (dk !== d) continue;
      for (const n of edges.get(k) || []) if (!onPanel.has(n) && (!fringe[n] || fringe[n][1] > d + 1)) fringe[n] = [side, d + 1];
    }
  }

  return {
    id: cfg.id, name: cfg.name, subtitle: areas.length ? `TD area${areas.length > 1 ? 's' : ''} ${areas.join(' · ')}` : cfg.subtitle, area, areas, ends: cfg.ends, crs: cfg.crs || null, style: 'iecc', tracks, fringe,
    source: { smartRows: all.length, stationRows: here.length, platforms: tracks.length, areas: count, fringeBerths: Object.keys(fringe).length, sharedApproaches: shared.south.size + shared.north.size }
  };
}

// For checking the result from a phone: the raw SMART rows behind the panel
export function smartDebug(smart, cfg) {
  const here = stationRows(smart, cfg);
  const areas = [...new Set(here.map((r) => (r.TD || '').trim()))];
  const all = (smart.BERTHDATA || []).filter((r) => areas.includes((r.TD || '').trim()));
  const names = {};
  for (const r of all) { const n = (r.STANME || '').trim(); names[n] = (names[n] || 0) + 1; }
  return { panel: cfg.id, areas, stanox: cfg.stanox || null, rows: all.length, stationRows: here.length, stations: Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 60), sample: here.slice(0, 80) };
}
