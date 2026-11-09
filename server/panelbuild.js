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
//   1-2 south approach · 3-4 platform · 5-6 north approach. Main lines beyond each end
//   are separate tracks ('lanes') drawn at the edges of the panel.

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
  const inbound = new Set(), outbound = new Set(); // approach berths trains arrive from / depart to
  const sides = new Map(); // approach berth -> 0 south (left) / 1 north (right), from SMART's event codes
  for (const r of here) {
    const p = (r.PLATFORM || '').trim();
    if (!p) continue;
    const ev = (r.EVENT || '').trim();
    const from = (r.FROMBERTH || '').trim(), to = (r.TOBERTH || '').trim();
    const x = P(p);
    if (ev === 'A' || ev === 'C') {          // arriving: "to" is the platform
      if (okBerth(to)) x.plat.add(key(r, to));
      if (okBerth(from)) { (ev === 'C' ? x.south : x.north).add(key(r, from)); inbound.add(key(r, from)); sides.set(key(r, from), ev === 'C' ? 0 : 1); }
    } else if (ev === 'B' || ev === 'D') {   // departing: "from" is the platform
      if (okBerth(from)) x.plat.add(key(r, from));
      if (okBerth(to)) { (ev === 'B' ? x.south : x.north).add(key(r, to)); outbound.add(key(r, to)); sides.set(key(r, to), ev === 'B' ? 0 : 1); }
    }
  }

  // A berth that is a platform anywhere is not an approach berth
  const platformBerths = new Set([...plats.values()].flatMap((x) => [...x.plat]));
  for (const x of plats.values()) for (const side of ['south', 'north']) for (const b of x[side]) if (platformBerths.has(b)) x[side].delete(b);

  // The stepping table: which berth a train steps into from which (directed)
  const next = new Map(), prev = new Map();
  const add = (m, a, b) => (m.get(a) || m.set(a, new Set()).get(a)).add(b);
  for (const r of all) {
    const f = (r.FROMBERTH || '').trim(), t = (r.TOBERTH || '').trim();
    if (okBerth(f) && okBerth(t)) { add(next, key(r, f), key(r, t)); add(prev, key(r, t), key(r, f)); }
  }

  // An approach berth used by several platforms is part of a main line, not one road,
  // so it goes on a main-line track at the edge of the panel and a train is never drawn twice.
  const uses = new Map();
  for (const x of plats.values()) for (const side of ['south', 'north']) for (const b of x[side]) uses.set(b, (uses.get(b) || 0) + 1);
  for (const x of plats.values()) for (const side of ['south', 'north']) for (const b of [...x[side]]) if (uses.get(b) > 1) x[side].delete(b);

  // Each road: approach berths left (south) and right (north), platform berths in the middle.
  // A slot can stand for several berths, so a train in any of them shows.
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
    const south = [...x.south].sort().reverse(), north = [...x.north].sort(), plat = [...x.plat].sort();
    if (south.length) { slot([south[0]], 2, 'line'); slot(south.slice(1), 1, 'line'); }
    if (plat.length <= 1) slot(plat, 3, 'platform'); else { const h = Math.ceil(plat.length / 2); slot(plat.slice(0, h), 3, 'platform'); slot(plat.slice(h), 4, 'platform'); }
    if (north.length) { slot([north[0]], 5, 'line'); slot(north.slice(1), 6, 'line'); }
    return { name: p, berths };
  }).filter((t) => t.berths.some((b) => b.kind === 'platform'));

  // Main-line tracks either side, from the stepping table. A track starts at a berth that
  // steps straight onto the panel (inbound) or straight off it (outbound), and runs out
  // from there along the steps. Which side, and which direction, come from SMART too.
  const onPanel = new Map(); // berth key -> road index
  tracks.forEach((t, i) => { for (const b of t.berths) for (const k of b.keys || [`${b.area || area}:${b.id}`]) onPanel.set(k, i); });
  const sideOf = (k) => sides.has(k) ? sides.get(k) : null;
  const lanes = [];
  const laneOf = {}; // berth key -> [lane index, steps from the station]
  const MAX = 8;
  for (const dir of ['in', 'out']) {
    const toward = dir === 'in' ? next : prev, away = dir === 'in' ? prev : next;
    // roots: off-panel berths that step directly onto (or off) the panel
    const roots = new Map(); // root -> { feeds:Set(road), side }
    for (const [k, i] of onPanel) for (const r of away.get(k) || []) {
      if (onPanel.has(r)) continue;
      const col = tracks[i].berths.find((b) => (b.keys || [`${b.area || area}:${b.id}`]).includes(k)).col;
      // the side comes from SMART for approach berths, else from where it joins the road
      const side = sideOf(r) ?? (col <= 2 ? 0 : col >= 5 ? 1 : null);
      if (side === null) continue; // can't tell which end: leave it off rather than guess
      const e = roots.get(r) || roots.set(r, { feeds: new Set(), side }).get(r);
      e.feeds.add(i);
    }
    // a root that steps into another root is part of that root's track
    for (const r of [...roots.keys()]) for (const n of toward.get(r) || []) if (roots.has(n) && n !== r) { for (const f of roots.get(r).feeds) roots.get(n).feeds.add(f); roots.delete(r); break; }
    for (const [r, info] of roots) {
      if (laneOf[r]) continue; // already on a track the other way: bidirectional, keep the first
      const li = lanes.push({ side: info.side, dir, feeds: [...info.feeds].sort((a, b) => a - b) }) - 1;
      laneOf[r] = [li, 1];
      let frontier = [r];
      for (let d = 2; d <= MAX && frontier.length; d++) {
        const nf = [];
        for (const b of frontier) for (const n of away.get(b) || []) if (!onPanel.has(n) && !laneOf[n]) { laneOf[n] = [li, d]; nf.push(n); }
        frontier = nf;
      }
    }
  }

  return {
    id: cfg.id, name: cfg.name, subtitle: areas.length ? `TD area${areas.length > 1 ? 's' : ''} ${areas.join(' · ')}` : cfg.subtitle, area, areas, ends: cfg.ends, crs: cfg.crs || null, style: 'iecc', tracks, lanes, laneOf,
    source: { smartRows: all.length, stationRows: here.length, platforms: tracks.length, areas: count, lanes: lanes.length, laneBerths: Object.keys(laneOf).length }
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
