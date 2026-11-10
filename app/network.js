// Design B, the network wall map: Britain's main lines drawn like an old
// control-room mimic board, each stretch between principal stations lit by how
// late the trains on it are running right now.
//
// Uses the same train positions as the map, fetched in tiles that cover the
// lines, and the same line-placing code as the Route tab.

import * as api from './api.js';
let tflLines = null;
import { BY_CRS } from './geo.js';
import { band } from './model.js';
import { place } from './route.js';
import { esc, shortLate, bandOf, openSheet, opBadge } from './ui.js';
import { statusSheet } from './tflstatus.js';

const line = (id, name, codes) => ({ id, name, crs: codes.split(' ') });
export const LINES = [
  line('ecml', 'East Coast Main Line', 'KGX SVG PBO GRA NNG RET DON YRK DAR DHM NCL BWK EDB'),
  line('abd', 'Edinburgh – Aberdeen', 'EDB INK KDY LEU DEE ARB ABD'),
  line('scot', 'Edinburgh – Glasgow', 'EDB FKK GLQ'),
  line('wcml', 'West Coast Main Line', 'EUS WFJ MKC RUG NUN TAM LTV STA CRE WBQ WGN PRE LAN OXN PNR CAR GLC'),
  line('wbhm', 'West Coast via Birmingham', 'RUG COV BHI BHM WVH STA'),
  line('mcr', 'Crewe – Manchester', 'CRE WML SPT MAN'),
  line('tpe', 'Liverpool – Leeds', 'LIV NLW MAN SYB HUD LDS'),
  line('yrk', 'Leeds – York', 'LDS CRG GRF MIK CHF ULL YRK'),
  line('sca', 'York – Scarborough', 'YRK MLT SEM SCA'),
  line('hull', 'Leeds – Hull', 'MIK SBY HOW GBD BUH HUL'),
  line('hulld', 'Doncaster – Hull', 'DON TNN GOO GBD'),
  line('mml', 'Midland Main Line', 'STP LUT BDM WEL KET MHR LEI LBO EMD DBY CHD SHF'),
  line('mmlnot', 'Midland Main Line – Nottingham', 'EMD BEE NOT'),
  line('xc', 'Cross Country', 'BRI CNM BHM TAM BUT DBY'),
  line('gwml', 'Great Western Main Line', 'PAD RDG DID SWI CPM BTH BRI'),
  line('west', 'Bristol – Penzance', 'BRI WSM TAU TVP EXD NTA PLY BOD TRU RED SER PNZ'),
  line('bh', 'Reading – Taunton (Berks & Hants)', 'RDG NBY PEW WSB CLC TAU'),
  line('swales', 'South Wales Main Line', 'SWI BPW NWP CDF SWA'),
  line('geml', 'Great Eastern Main Line', 'LST SRA CHM COL IPS DIS NRW'),
  line('hs1', 'High Speed 1', 'STP SFA EBD AFK'),
  line('swml', 'South Western Main Line', 'WAT CLJ WOK BSK WIN SOU BMH'),
  line('bml', 'Brighton Main Line', 'VIC CLJ ECR GTW HHE BTN')
];
const LABELS = { KGX: 'London', EDB: 'Edinburgh', GLC: 'Glasgow', ABD: 'Aberdeen', NCL: 'Newcastle', YRK: 'York', LDS: 'Leeds', MAN: 'Manchester', LIV: 'Liverpool', SHF: 'Sheffield', DON: 'Doncaster', CRE: 'Crewe', BHM: 'Birmingham', PBO: 'Peterborough', DBY: 'Derby', LEI: 'Leicester', BRI: 'Bristol', CDF: 'Cardiff', SWA: 'Swansea', RDG: 'Reading', NRW: 'Norwich', SOU: 'Southampton', BTN: 'Brighton', AFK: 'Ashford', CAR: 'Carlisle', PRE: 'Preston', SCA: 'Scarborough', DEE: 'Dundee', BMH: 'Bournemouth', HUL: 'Hull', NOT: 'Nottingham', EXD: 'Exeter', PLY: 'Plymouth', PNZ: 'Penzance', TAU: 'Taunton' };
const BELOW_LABEL = new Set(['PNZ']);
const LEFT_LABEL = new Set(['PLY', 'EXD', 'TAU', 'SBY', 'LIV', 'GLC', 'PRE', 'CAR', 'CRE', 'BRI', 'CDF', 'SWA', 'BMH', 'SOU', 'BHM', 'RDG']);

// Map tiles that cover the lines, each fetched once
function tiles() {
  const cells = new Set();
  for (const l of LINES) {
    for (let i = 1; i < l.crs.length; i++) {
      const a = BY_CRS.get(l.crs[i - 1]), b = BY_CRS.get(l.crs[i]);
      for (let f = 0; f <= 1; f += 0.1) cells.add(Math.floor((a.lat + (b.lat - a.lat) * f) * 2) + ':' + Math.floor((a.lon + (b.lon - a.lon) * f) * 1.4));
    }
  }
  return [...cells].map((c) => {
    const [y, x] = c.split(':').map(Number);
    return { s: y / 2 - 0.06, n: (y + 1) / 2 + 0.06, w: x / 1.4 - 0.09, e: (x + 1) / 1.4 + 0.09 };
  });
}
const TILES = tiles();

const state = { trains: new Map(), prev: {}, memory: new Map(), mode: null, at: 0, busy: false, segs: null };

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    const res = await Promise.all(TILES.map((b) => api.trains(b, 1500).catch(() => null)));
    const seen = new Map();
    state.error = null;
    for (const r of res) if (r && r.trains) { state.mode = r.mode; for (const t of r.trains) seen.set(t.id, t); }
    if (!seen.size && res.some((r) => r && r.error)) { state.error = res.find((r) => r && r.error).error; state.segs = null; state.memory.clear(); return; }
    if (!seen.size && !state.mode) return;
    const now = Date.now();
    const segs = {};
    for (const l of LINES) {
      const placed = place(l, [...seen.values()], state.prev[l.id] || new Map());
      state.prev[l.id] = new Map(placed.map((t) => [t.id, { pos: t.pos, dir: t.dir }]));
      for (let i = 0; i < l.crs.length - 1; i++) {
        const inside = placed.filter((t) => t.pos >= i && t.pos < i + 1);
        const timed = inside.filter((t) => t.delay != null);
        const key = l.id + ':' + i;
        let avg = null;
        // Only trains on the stretch now: an empty stretch shows as grey, not its last colour
        if (timed.length) avg = Math.round(timed.reduce((s, t) => s + Math.max(0, t.delay), 0) / timed.length);
        const late = inside.filter((t) => t.cancelled || t.delay >= 2).length;
        segs[key] = { avg, band: avg == null ? 'none' : band({ delay: avg }), trains: inside, late, worst: Math.max(0, ...timed.map((t) => t.delay)) };
      }
    }
    state.segs = segs;
    state.at = now;
  } finally { state.busy = false; }
}

// ---- drawing ----
const W = 400;
function projector() {
  const pts = LINES.flatMap((l) => l.crs.map((c) => BY_CRS.get(c)));
  const k = Math.cos(54 * Math.PI / 180);
  const xs = pts.map((p) => p.lon * k), ys = pts.map((p) => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 40, s = (W - pad * 2) / (maxX - minX);
  return { H: Math.round((maxY - minY) * s + pad * 2 + 30), xy: (p) => [pad + (p.lon * k - minX) * s, pad + 18 + (-p.lat - minY) * s] };
}
const P = projector();

function svg() {
  let g = '';
  // lines, under the station ticks
  for (const l of LINES) {
    for (let i = 0; i < l.crs.length - 1; i++) {
      const [x1, y1] = P.xy(BY_CRS.get(l.crs[i])), [x2, y2] = P.xy(BY_CRS.get(l.crs[i + 1]));
      const sg = state.segs && state.segs[l.id + ':' + i];
      const bd = sg ? sg.band : 'none';
      g += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="nw-glow b-${bd}"/>`;
      g += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="nw-seg b-${bd}" data-seg="${l.id}:${i}"><title>${esc(BY_CRS.get(l.crs[i]).name)} – ${esc(BY_CRS.get(l.crs[i + 1]).name)}</title></line>`;
      g += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="nw-hit" data-seg="${l.id}:${i}"/>`;
    }
  }
  const drawn = new Set();
  for (const l of LINES) for (const c of l.crs) {
    if (drawn.has(c)) continue;
    drawn.add(c);
    const [x, y] = P.xy(BY_CRS.get(c));
    const big = LABELS[c];
    g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${big ? 3.4 : 1.8}" class="nw-stn${big ? ' big' : ''}" data-crs="${c}"/>`;
    if (big) {
      const left = LEFT_LABEL.has(c);
      if (BELOW_LABEL.has(c)) g += `<text x="${(x - 4).toFixed(1)}" y="${(y + 13).toFixed(1)}" class="nw-lbl" text-anchor="start" data-crs="${c}">${esc(big.toUpperCase())}</text>`;
      else g += `<text x="${(x + (left ? -6 : 6)).toFixed(1)}" y="${(y + 3).toFixed(1)}" class="nw-lbl" text-anchor="${left ? 'end' : 'start'}" data-crs="${c}">${esc(big.toUpperCase())}</text>`;
    }
  }
  g += `<text x="${W / 2}" y="22" class="lbl big" text-anchor="middle">NETWORK</text>`;
  if (state.at) g += `<text x="10" y="${P.H - 10}" class="clock">${new Date(state.at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })}</text>`;
  return `<svg class="iecc nw" viewBox="0 0 ${W} ${P.H}" role="img" aria-label="Wall map of Britain's main lines coloured by delay">${g}</svg>`;
}

function worstList() {
  if (!state.segs) return '';
  const rows = [];
  for (const l of LINES) for (let i = 0; i < l.crs.length - 1; i++) {
    const s = state.segs[l.id + ':' + i];
    if (s && s.trains.length && s.avg != null && s.avg >= 2) rows.push({ l, i, s });
  }
  rows.sort((a, b) => b.s.avg - a.s.avg);
  const html = rows.slice(0, 8).map(({ l, i, s }) => `<button class="row" data-seg="${l.id}:${i}"><span class="hc b-${s.band}">+${s.avg}</span>
    <span class="what">${esc(BY_CRS.get(l.crs[i]).name)} – ${esc(BY_CRS.get(l.crs[i + 1]).name)}<small class="sub-line">${esc(l.name)} · ${s.trains.length} train${s.trains.length === 1 ? '' : 's'}, ${s.late} late</small></span></button>`).join('');
  return `<section class="list"><div class="list-h">Worst stretches right now</div>${html || '<div class="empty">No stretch is averaging 2 minutes late or more.</div>'}</section>`;
}

let el = null, timer = null, onTrain = null, onStation = null;
function render() {
  if (!el) return;
  const all = state.segs ? Object.values(state.segs) : [];
  const total = new Set(all.flatMap((s) => s.trains.map((t) => t.id))).size;
  const late = new Set(all.flatMap((s) => s.trains.filter((t) => t.cancelled || t.delay >= 2).map((t) => t.id))).size;
  const pill = state.error ? '<span class="pill wait c-bad">Offline</span>' : state.mode ? `<span class="pill ${state.mode === 'live' ? 'live' : 'demo'}">${state.mode === 'live' ? 'Live' : 'Demo'}</span>` : '<span class="pill wait">Loading</span>';
  el.innerHTML = `<header class="head"><h1>Network</h1><div class="sub">Main lines, lit by how late trains are running</div>
      <div class="sub">${pill}<span>${state.error ? esc(state.error) : state.segs ? `${total} trains on these lines · <span class="c-mid">${late} late</span>` : 'Finding trains…'}</span></div></header>
    <div class="iecc-wrap">${svg()}</div>
    <p class="note">Each stretch shows the average delay of the trains on it. Tap a stretch for its trains, or a station for its board.</p>
    <div class="legend"><span><i class="b-ok"></i>On time</span><span><i class="b-mid"></i>2–9 late</span><span><i class="b-bad"></i>10+ late</span><span><i class="b-none"></i>No trains</span></div>
    ${worstList()}
    ${londonLines()}`;
}

// TfL line status: Good service, Minor delays, Part closure... with TfL's explanation
const sevBand = (sev) => (sev === 10 ? 'ok' : sev === 9 || sev === 19 ? 'mid' : 'bad');
function londonLines() {
  if (!tflLines || !tflLines.length) return '';
  const rows = tflLines.map((l) => `<button class="row" data-tfl="${esc(l.id)}"><span class="lbar" style="background:${esc(l.color || '#59606B')}"></span>
    <span class="what">${esc(l.name)}${l.reason && l.severity !== 10 ? `<small class="sub-line">${esc(l.reason.slice(0, 90))}${l.reason.length > 90 ? '…' : ''}</small>` : ''}</span>
    <span class="mins c-${sevBand(l.severity)}">${esc(l.status || '')}</span></button>`).join('');
  return `<section class="list"><div class="list-h">London lines · TfL <button class="linkish" data-tflall="1">All lines ›</button></div>${rows}</section><p class="credit">Powered by TfL Open Data</p>`;
}

function segSheet(key) {
  const [id, i] = key.split(':');
  const l = LINES.find((x) => x.id === id);
  const s = state.segs && state.segs[key];
  if (!l || !s) return;
  const a = BY_CRS.get(l.crs[+i]).name, b = BY_CRS.get(l.crs[+i + 1]).name;
  const items = [...s.trains].sort((x, y) => (y.delay ?? -1) - (x.delay ?? -1));
  const rows = items.map((t) => {
    const bd = bandOf(t.delay, t.cancelled);
    return `<button class="row" data-act="train" data-arg="${esc(t.id)}"><span class="hc b-${bd}">${esc(t.code)}</span>
      <span class="what">${t.dir === 'down' ? '→ ' + esc(b) : '→ ' + esc(a)}${t.dest || t.toc ? `<small class="sub-line">${opBadge(t.toc)}${t.dest ? 'to ' + esc(t.dest) : esc(t.toc)}</small>` : ''}</span><span class="mins c-${bd}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`;
  }).join('');
  openSheet(`<div class="st-head"><div><div class="meta">${esc(l.name)}</div><h2 id="sheet-title">${esc(a)} – ${esc(b)}</h2></div></div>
    <div class="sheet-body list flush">${rows || '<div class="empty">No trains on this stretch right now.</div>'}</div>
    <div class="sheet-actions one"><button data-act="route">Show ${esc(l.name)} on the Route tab</button></div>`, {
    train: (tid) => { const t = items.find((x) => x.id === tid); if (t && onTrain) onTrain(t); },
    route: () => window.dispatchEvent(new CustomEvent('mtt:route', { detail: { route: { id: 'net-' + l.id, name: l.name, crs: l.crs }, train: l.name, quiet: true } }))
  });
}

export function showNetwork(container, handlers) {
  el = container;
  onTrain = handlers.train; onStation = handlers.station;
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => {
      const tl = e.target.closest('[data-tfl]');
      if (tl) {
        const l = tflLines.find((x) => x.id === tl.dataset.tfl);
        if (l) statusSheet(l.id);
        return;
      }
      if (e.target.closest('[data-tflall]')) return statusSheet();
      const sg = e.target.closest('[data-seg]');
      if (sg) return segSheet(sg.dataset.seg);
      const st = e.target.closest('[data-crs]');
      if (st && onStation) onStation(st.dataset.crs);
    });
  }
  render();
  if (!state.at || Date.now() - state.at > 30000) refresh().then(render);
  api.tflStatus().then((r) => { if (r && r.lines) { tflLines = r.lines; render(); } });
  if (!timer) timer = setInterval(() => { if (!el.hidden && !document.hidden) refresh().then(render); }, 60000);
}
