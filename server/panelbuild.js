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
  const used = new Set([...platformBerths, ...[...plats.values()].flatMap((x) => [...x.south, ...x.north])]);
  const outer = (set) => { for (const b of set) for (const n of edges.get(b) || []) if (!used.has(n)) return n; return null; };

  const tracks = [...plats.keys()].sort(platOrder).map((p) => {
    const x = plats.get(p);
    const berths = [];
    const B = (k, col, kind) => { const [a, id] = k.split(':'); const b = { id, col, kind }; if (a !== area) b.area = a; berths.push(b); };
    const put = (list, cols, kind) => list.slice(0, cols.length).forEach((k, i) => B(k, cols[i], kind));
    const so = outer(x.south), no = outer(x.north);
    if (so) { used.add(so); B(so, 0, 'line'); }
    put([...x.south].sort().reverse(), [2, 1], 'line');
    put([...x.plat].sort(), [3, 4], 'platform');
    put([...x.north].sort(), [5, 6], 'line');
    if (no) { used.add(no); B(no, 7, 'line'); }
    return { name: p, berths };
  }).filter((t) => t.berths.some((b) => b.kind === 'platform'));

  return {
    id: cfg.id, name: cfg.name, subtitle: areas.length ? `TD area${areas.length > 1 ? 's' : ''} ${areas.join(' · ')}` : cfg.subtitle, area, areas, ends: cfg.ends, style: 'iecc', tracks,
    source: { smartRows: all.length, stationRows: here.length, platforms: tracks.length, areas: count }
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
