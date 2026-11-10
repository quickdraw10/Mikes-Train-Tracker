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
//   0-4 south approaches · 5-6 platform · 7-11 north approaches, with the switches between
//   roads drawn from the stepping table. Trains further out are listed at each edge.

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
  if (!cfg.stanme) return [];
  // no area given: look for the station's SMART name anywhere (platform rows only)
  const inArea = cfg.area ? rows.filter((r) => (r.TD || '').trim() === cfg.area) : rows.filter((r) => (r.PLATFORM || '').trim());
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
  const ends = new Map();  // platform berth -> Set of ends (0 south, 1 north) it is reached from
  for (const r of here) {
    const p = (r.PLATFORM || '').trim();
    if (!p) continue;
    const ev = (r.EVENT || '').trim();
    const from = (r.FROMBERTH || '').trim(), to = (r.TOBERTH || '').trim();
    const x = P(p);
    if (ev === 'A' || ev === 'C') {          // arriving: "to" is the platform
      if (okBerth(to)) { x.plat.add(key(r, to)); (ends.get(key(r, to)) || ends.set(key(r, to), new Set()).get(key(r, to))).add(ev === 'C' ? 0 : 1); }
      if (okBerth(from)) { (ev === 'C' ? x.south : x.north).add(key(r, from)); inbound.add(key(r, from)); sides.set(key(r, from), ev === 'C' ? 0 : 1); }
    } else if (ev === 'B' || ev === 'D') {   // departing: "from" is the platform
      if (okBerth(from)) { x.plat.add(key(r, from)); (ends.get(key(r, from)) || ends.set(key(r, from), new Set()).get(key(r, from))).add(ev === 'B' ? 0 : 1); }
      if (okBerth(to)) { (ev === 'B' ? x.south : x.north).add(key(r, to)); outbound.add(key(r, to)); sides.set(key(r, to), ev === 'B' ? 0 : 1); }
    }
  }

  // A berth that is a platform anywhere is not an approach berth
  const platformBerths = new Set([...plats.values()].flatMap((x) => [...x.plat]));
  for (const x of plats.values()) for (const side of ['south', 'north']) for (const b of x[side]) if (platformBerths.has(b)) x[side].delete(b);

  // The stepping table (which berth a train can step into from which), both ways
  const nb = new Map();
  const add = (a, b) => (nb.get(a) || nb.set(a, new Set()).get(a)).add(b);
  for (const r of all) {
    const f = (r.FROMBERTH || '').trim(), t = (r.TOBERTH || '').trim();
    if (okBerth(f) && okBerth(t)) { add(key(r, f), key(r, t)); add(key(r, t), key(r, f)); }
  }

  // Roads, one per platform, in platform order. Columns, left (south) to right (north):
  //   0-4 south approaches (4 = next to the platform) · 5-6 platform · 7-11 north approaches
  const DEPTH = 5, BEYOND = 12;
  const roads = [...plats.keys()].sort(platOrder).filter((p) => plats.get(p).plat.size);
  const roadOf = new Map(); // platform berth -> road index
  roads.forEach((p, i) => { for (const b of plats.get(p).plat) roadOf.set(b, i); });
  const cells = new Map(); // "road:col" -> { road, col, kind, keys: [] }
  const put = (road, col, kind, k) => { const id = road + ':' + col; const c = cells.get(id) || cells.set(id, { road, col, kind, keys: [] }).get(id); if (!c.keys.includes(k)) c.keys.push(k); return c; };
  const at = new Map(); // berth key -> cell
  roads.forEach((p, i) => {
    const pl = [...plats.get(p).plat].sort();
    for (const b of pl) {
      const e = ends.get(b) || new Set();
      const col = pl.length === 1 ? 5 : e.has(0) && !e.has(1) ? 5 : e.has(1) && !e.has(0) ? 6 : (pl.indexOf(b) < pl.length / 2 ? 5 : 6);
      at.set(b, put(i, col, 'platform', b));
    }
  });

  // Approaches, found by stepping out from the platforms. Each berth is drawn once, on the
  // road in the middle of the roads it leads to, so a train is never drawn twice; where
  // a berth leads to several roads the connections are drawn as switches (crossovers).
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  const depthOf = new Map(); // berth -> { side, d }
  let frontier = [];
  for (const b of roadOf.keys()) for (const n of nb.get(b) || []) {
    if (roadOf.has(n) || depthOf.has(n) || !sides.has(n)) continue; // side must come from SMART
    depthOf.set(n, { side: sides.get(n), d: 1 });
    frontier.push(n);
  }
  const roadsTouched = (k) => [...(nb.get(k) || [])].map((n) => roadOf.get(n) ?? (at.get(n) && depthOf.get(n) && depthOf.get(n).d < depthOf.get(k).d ? at.get(n).road : null)).filter((x) => x != null);
  const beyond = {}; // berth key -> [cell id, steps beyond the drawn approach]
  for (let d = 1; d <= BEYOND && frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      const { side } = depthOf.get(k);
      if (d <= DEPTH) {
        const rs = roadsTouched(k);
        if (!rs.length) continue;
        const col = side === 0 ? DEPTH - d : 6 + d;
        at.set(k, put(median(rs), col, 'line', k));
      } else {
        // further out than we draw: counted against the outermost drawn berth it leads to
        const parent = [...(nb.get(k) || [])].find((n) => at.has(n) && depthOf.get(n) && depthOf.get(n).d === DEPTH) || [...(nb.get(k) || [])].find((n) => beyond[n]);
        if (!parent) continue;
        const pid = at.has(parent) ? at.get(parent).road + ':' + at.get(parent).col : beyond[parent][0];
        beyond[k] = [pid, at.has(parent) ? 1 : beyond[parent][1] + 1];
      }
      for (const n of nb.get(k) || []) if (!roadOf.has(n) && !depthOf.has(n)) { depthOf.set(n, { side, d: d + 1 }); next.push(n); }
    }
    frontier = next;
  }

  // Switches: every step between berths drawn on different roads in neighbouring columns
  const links = new Set();
  for (const [k, c] of at) for (const n of nb.get(k) || []) {
    const c2 = at.get(n);
    if (!c2 || c2 === c || c2.road === c.road || Math.abs(c2.col - c.col) !== 1) continue;
    const [a, b] = c.col < c2.col ? [c, c2] : [c2, c];
    links.add(`${a.road}:${a.col}>${b.road}:${b.col}`);
  }

  const tracks = roads.map((p, i) => ({
    name: p,
    berths: [...cells.values()].filter((c) => c.road === i).sort((a, b) => a.col - b.col).map((c) => {
      const [a, id] = c.keys[0].split(':');
      const b = { id, col: c.col, kind: c.kind };
      if (a !== area) b.area = a;
      if (c.keys.length > 1) b.keys = c.keys;
      return b;
    })
  }));

  return {
    id: cfg.id, name: cfg.name, subtitle: areas.length ? `TD area${areas.length > 1 ? 's' : ''} ${areas.join(' · ')}` : cfg.subtitle, area, areas, ends: cfg.ends, crs: cfg.crs || null, style: 'iecc', cols: 12, tracks, links: [...links], beyond,
    source: { smartRows: all.length, stationRows: here.length, platforms: tracks.length, areas: count, drawnBerths: at.size, switches: links.size, beyondBerths: Object.keys(beyond).length }
  };
}

// For checking the result from a phone: the raw SMART rows behind the panel
// For finding how a station is named in SMART: every name/area/STANOX matching the search
export function smartFind(smart, q) {
  const want = String(q || '').toUpperCase().trim();
  const out = {};
  for (const r of smart.BERTHDATA || []) {
    const n = (r.STANME || '').trim();
    if (!want || !n.toUpperCase().includes(want)) continue;
    const k = `${n}|${(r.TD || '').trim()}|${(r.STANOX || '').trim()}`;
    const o = out[k] || (out[k] = { stanme: n, td: (r.TD || '').trim(), stanox: (r.STANOX || '').trim(), rows: 0, platformRows: 0, platforms: [] });
    o.rows++;
    const pl = (r.PLATFORM || '').trim();
    if (pl) { o.platformRows++; if (!o.platforms.includes(pl)) o.platforms.push(pl); }
  }
  return Object.values(out).sort((a, b) => b.platformRows - a.platformRows || b.rows - a.rows);
}

export function smartDebug(smart, cfg) {
  const here = stationRows(smart, cfg);
  const areas = [...new Set(here.map((r) => (r.TD || '').trim()))];
  const all = (smart.BERTHDATA || []).filter((r) => areas.includes((r.TD || '').trim()));
  const names = {};
  for (const r of all) { const n = (r.STANME || '').trim(); names[n] = (names[n] || 0) + 1; }
  return { panel: cfg.id, areas, stanox: cfg.stanox || null, rows: all.length, stationRows: here.length, stations: Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 60), sample: here.slice(0, 80) };
}
