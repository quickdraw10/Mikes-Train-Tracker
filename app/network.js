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
import { statusSheet, statusListHTML } from './tflstatus.js';
import { LU_KEY, luShort } from './mapview.js';
import { zoomable } from './zoom.js';

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

// ---- the Network tab: pages you swipe between ----
// Rail network → Delays → Tube map → Tube status. Swipe sideways, or tap the names along the top.
const PAGES = [['rail', 'Rail'], ['delays', 'Delays'], ['tube', 'Tube map'], ['status', 'Tube status']];
let page = 'rail';
const $p = (name) => el && el.querySelector(`.np-page[data-p="${name}"]`);

function railHead() {
  const all = state.segs ? Object.values(state.segs) : [];
  const total = new Set(all.flatMap((s) => s.trains.map((t) => t.id))).size;
  const late = new Set(all.flatMap((s) => s.trains.filter((t) => t.cancelled || t.delay >= 2).map((t) => t.id))).size;
  const pill = state.error ? '<span class="pill wait c-bad">Offline</span>' : state.mode ? `<span class="pill ${state.mode === 'live' ? 'live' : 'demo'}">${state.mode === 'live' ? 'Live' : 'Demo'}</span>` : '<span class="pill wait">Loading</span>';
  return `<header class="head"><h1>Network</h1><div class="sub">Main lines, lit by how late trains are running</div>
      <div class="sub">${pill}<span>${state.error ? esc(state.error) : state.segs ? `${total} trains on these lines · <span class="c-mid">${late} late</span>` : 'Finding trains…'}</span></div></header>`;
}
function railRest() {
  return `<p class="note">Pinch or use + and − to zoom. Each stretch shows the average delay of the trains on it. Tap a stretch for its trains, or a station for its board.</p>
    <div class="legend"><span><i class="b-ok"></i>On time</span><span><i class="b-mid"></i>2–9 late</span><span><i class="b-bad"></i>10+ late</span><span><i class="b-none"></i>No trains</span></div>
    ${worstList()}
    ${londonLines()}`;
}
let railZoom = null, tubeZoom = null;
function railPage() {
  const pg = $p('rail');
  if (!pg) return;
  if (!pg.querySelector('.zsvg')) {
    pg.innerHTML = '<div class="r-head"></div><div class="iecc-wrap zwrap"><div class="zsvg"></div></div><div class="r-rest"></div>';
    railZoom = zoomable(pg.querySelector('.zwrap'), { pager: el.querySelector('.np-pager'), page: pg });
  }
  pg.querySelector('.r-head').innerHTML = railHead();
  pg.querySelector('.zsvg').innerHTML = svg();
  railZoom.apply();
  pg.querySelector('.r-rest').innerHTML = railRest();
}

function render() {
  if (!el) return;
  railPage();
  renderStatus();
  renderDelays();
}

// ---- Tube map: how each line is running, drawn on TfL's own route data, with live trains ----
// Lines with a problem get an amber or red glow (TfL's status can apply to part of a line);
// the list under the map gives each line's status, and tapping one picks it out on the map.
const BOUNDS = { w: -0.62, e: 0.30, s: 51.33, n: 51.71 };
const CENTRAL = { w: -0.27, e: 0.03, s: 51.47, n: 51.56 };
let tube = { shapes: null, trains: [], at: 0, timer: null, status: null, focus: null, firstView: true };
const tubeBand = (sev) => (sev == null || sev === 10 || sev === 18 || sev === 19 ? 'ok' : sev === 9 || sev === 7 || sev === 8 ? 'mid' : 'bad');
const TW = 1000, K = Math.cos(51.5 * Math.PI / 180);
const TH = Math.round(TW * (BOUNDS.n - BOUNDS.s) / ((BOUNDS.e - BOUNDS.w) * K));
const txy = (lat, lon) => [((lon - BOUNDS.w) * K / ((BOUNDS.e - BOUNDS.w) * K)) * TW, ((BOUNDS.n - lat) / (BOUNDS.n - BOUNDS.s)) * TH];
const statusOf = (id) => (tube.status && tube.status.lines ? tube.status.lines.find((l) => l.id === id) : null);

// Station initials for the Tube map: King's Cross St. Pancras → KXStP, Covent Garden → CG,
// Elephant & Castle → E&C, Harrow-on-the-Hill → HotH. One-word names use their first three
// letters (Bank → Ban) so they're still recognisable. The full name shows when you tap.
const SMALL = new Set(['on', 'the', 'of', 'upon', 'le', 'in', 'at', 'and']);
export function initials(name) {
  const words = String(name || '').replace(/\(.*?\)/g, ' ').replace(/[''.]/g, '').split(/[\s-]+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3);
  return words.map((w, i) => {
    const lw = w.toLowerCase();
    if (w === '&') return '&';
    if (/^\d/.test(w)) return w;
    if (lw === 'cross') return 'X';
    if ((lw === 'st' || lw === 'saint') && i < words.length - 1) return 'St';
    if (SMALL.has(lw) && i > 0) return lw[0];
    return w[0].toUpperCase();
  }).join('');
}

function tubeSVG() {
  let under = '', lines = '', dots = '', labels = '', trains = '';
  const f = tube.focus;
  for (const l of (tube.shapes && tube.shapes.lines) || []) {
    const st = statusOf(l.id);
    const bd = st ? tubeBand(st.severity) : 'ok';
    const on = !f || f === l.id;
    for (const path of l.paths) {
      const pts = path.map(([la, lo]) => txy(la, lo).map((v) => v.toFixed(1)).join(',')).join(' ');
      if (bd !== 'ok' && on) under += `<polyline points="${pts}" class="tm-halo h-${bd}"/>`;
      lines += `<polyline points="${pts}" class="tm-line${on ? '' : ' dim'}" stroke="${l.color}" data-line="${l.id}"/>`;
    }
  }
  const named = new Set();
  for (const [code, st] of BY_CRS) {
    if (st.country !== 'tfl') continue;
    if (f && !(st.lines || []).includes(f)) continue;
    const [x, y] = txy(st.lat, st.lon);
    const short = luShort(st.name);
    const inter = (st.lines || []).length > 1;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" class="tm-stn${inter ? ' inter' : ''}" data-crs="${esc(code)}"/>`;
    if (named.has(short)) continue;
    named.add(short);
    // landmark names always; interchanges from 2x zoom; every station from 4x (or all, for a picked line, from 2x)
    const lvl = LU_KEY.has(short.toLowerCase()) ? 'k' : inter ? 'i' : 'm';
    labels += `<text x="${(x + 4).toFixed(1)}" y="${(y - 3).toFixed(1)}" class="tm-lbl l-${lvl}" data-crs="${esc(code)}"><title>${esc(short)}</title>${esc(initials(short))}</text>`;
  }
  for (const t of tube.trains) {
    if (f && t.line !== f) continue;
    const [x, y] = txy(t.lat, t.lon);
    trains += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${esc(t.color || '#FFFFFF')}" class="tm-train" data-train="${esc(t.id)}"/>`;
  }
  return `<svg class="tm${f ? ' focused' : ''}" viewBox="0 0 ${TW} ${TH}" role="img" aria-label="London's Underground, DLR and tram lines, how each is running, and live trains">${under}${lines}${dots}${trains}${labels}</svg>`;
}
function tubeList() {
  const ls = tube.status && tube.status.lines ? tube.status.lines : null;
  if (!ls) return '<div class="empty">Loading line status…</div>';
  return ls.map((l) => {
    const bd = tubeBand(l.severity);
    const sts = (l.statuses && l.statuses.length ? l.statuses : [l]).map((x) => x.status).filter(Boolean);
    const drawn = tube.shapes && tube.shapes.lines.some((x) => x.id === l.id);
    const on = tube.focus === l.id;
    return `<button class="tl-row${on ? ' on' : ''}" data-tline="${esc(l.id)}" ${drawn ? '' : 'data-nodraw="1"'}>
      <span class="tl-sw" style="background:${esc(l.color || '#59606B')}"></span>
      <span class="tl-name">${esc(l.name)}</span>
      <span class="tl-st c-${bd === 'ok' ? 'ok' : bd}">${esc(sts.join(' · ') || '–')}</span></button>
      ${on && l.statuses && l.statuses.some((x) => x.reason) ? `<div class="tl-why">${l.statuses.filter((x) => x.reason).map((x) => `<p>${esc(x.reason)}</p>`).join('')}</div>` : ''}`;
  }).join('');
}
function renderTube() {
  const pg = $p('tube');
  if (!pg) return;
  if (!pg.querySelector('.zsvg')) {
    pg.innerHTML = `<div class="t-head"></div><div class="tm-wrap zwrap"><div class="zsvg"></div></div>
      <div class="tm-key"><span><i class="k-ok"></i>Good service</span><span><i class="k-mid"></i>Minor delays</span><span><i class="k-bad"></i>Severe / suspended / closed</span></div>
      <section class="list tl"><div class="list-h">Lines · tap one to pick it out</div><div class="t-list"></div></section>
      <p class="note">The glow means TfL reports a problem on that line; it may only affect part of it. Tap a station for its board, or a train for its next stops.</p>
      <p class="credit">Powered by TfL Open Data</p>`;
    tubeZoom = zoomable(pg.querySelector('.zwrap'), { pager: el.querySelector('.np-pager'), page: pg });
  }
  const bad = tube.status && tube.status.lines ? tube.status.lines.filter((l) => tubeBand(l.severity) !== 'ok').length : 0;
  pg.querySelector('.t-head').innerHTML = `<header class="head"><h1>Tube map</h1>
    <div class="sub">${tube.at ? '<span class="pill live">Live</span>' : '<span class="pill wait">Loading</span>'}<span>${tube.trains.length} trains${tube.status ? ` · ${bad ? `<span class="c-mid">${bad} line${bad === 1 ? '' : 's'} with problems</span>` : 'good service on all lines'}` : ''}</span></div></header>`;
  pg.querySelector('.zsvg').innerHTML = tube.shapes ? tubeSVG() : '<div class="empty">Loading the lines…</div>';
  if (tube.shapes) {
    tubeZoom.apply();
    if (tube.firstView) { tube.firstView = false; const [x1, y1] = txy(CENTRAL.n, CENTRAL.w), [x2, y2] = txy(CENTRAL.s, CENTRAL.e); tubeZoom.show(x1, y1, x2 - x1, y2 - y1); }
  }
  pg.querySelector('.t-list').innerHTML = tubeList();
}
function focusLine(id) {
  tube.focus = tube.focus === id ? null : id;
  renderTube();
  // zoom to the picked line
  const l = tube.focus && tube.shapes && tube.shapes.lines.find((x) => x.id === tube.focus);
  if (l) {
    const pts = l.paths.flat().map(([la, lo]) => txy(la, lo));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    tubeZoom.show(x - w * 0.08, y - h * 0.08, w * 1.16, h * 1.16);
  }
}
async function loadTube() {
  if (!tube.shapes) tube.shapes = await api.tflLines().catch(() => null);
  const [r, st] = await Promise.all([api.trains(BOUNDS, 2500, 'tfl').catch(() => null), api.tflStatus().catch(() => null)]);
  if (r && r.trains) { tube.trains = r.trains; tube.at = Date.now(); }
  if (st) tube.status = st;
  renderTube();
}

// ---- Tube status: the same list as the status popup, as a page ----
let stData = null;
const stOpen = new Set();
function renderStatus() {
  const pg = $p('status');
  if (!pg) return;
  const v = statusListHTML(stData, stOpen);
  pg.innerHTML = `<header class="head"><h1>Tube status</h1><div class="sub">Live from TfL · every London line</div></header><div class="pad">${v.sum}${v.body}</div>`;
}

// ---- Delays: average delay by main line and by train company, right now ----
let dlData = null;
function bars(rows) {
  const max = Math.max(5, ...rows.map((r) => r.avg || 0));
  return rows.map((r) => {
    const bd = r.avg == null ? 'none' : band({ delay: Math.round(r.avg) });
    const tag = r.route ? 'button' : 'div';
    return `<${tag} class="dl-row${r.route ? ' link' : ''}"${r.route ? ` data-route="${esc(r.route)}" aria-label="${esc(r.name)}: show on the Route tab"` : ''}><div class="dl-name">${r.badge || ''}${esc(r.name)}<small>${esc(r.sub)}</small></div>
      <div class="dl-bar"><i class="b-${bd}" style="width:${r.avg == null ? 0 : Math.max(3, (r.avg / max) * 100).toFixed(0)}%"></i></div>
      <div class="dl-val c-${bd}">${r.avg == null ? '–' : r.avg < 0.5 ? '0' : '+' + (Math.round(r.avg * 10) / 10)}${r.route ? '<span class="dl-go">›</span>' : ''}</div></${tag}>`;
  }).join('');
}
function renderDelays() {
  const pg = $p('delays');
  if (!pg) return;
  // main lines: from the trains on each line on the Rail page (same live positions)
  const lines = [];
  if (state.segs) for (const l of LINES) {
    const seen = new Map();
    for (let i = 0; i < l.crs.length - 1; i++) for (const t of (state.segs[l.id + ':' + i] || { trains: [] }).trains) seen.set(t.id, t);
    const ts = [...seen.values()], timed = ts.filter((t) => typeof t.delay === 'number' && !t.cancelled);
    lines.push({ route: l.id, name: l.name, avg: timed.length ? timed.reduce((s, t) => s + Math.max(0, t.delay), 0) / timed.length : null,
      sub: ts.length ? `${ts.length} train${ts.length === 1 ? '' : 's'} · ${ts.filter((t) => t.cancelled || t.delay >= 5).length} 5+ late` : 'No trains right now' });
  }
  lines.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  const ops = dlData && dlData.operators ? dlData.operators.filter((o) => o.trains >= 3).map((o) => ({ name: o.name, avg: o.avg, badge: opBadge(o.name, o.code),
    sub: `${o.trains} trains · ${o.timed ? Math.round((o.onTime / o.timed) * 100) + '% on time' : 'no live times'}${o.cancelled ? ` · ${o.cancelled} cancelled` : ''}` })) : null;
  const ov = dlData && dlData.overall;
  pg.innerHTML = `<header class="head"><h1>Delays</h1><div class="sub">Average minutes late, from trains running now</div>
      ${ov ? `<div class="sub"><span class="pill ${dlData.mode === 'live' ? 'live' : 'demo'}">${dlData.mode === 'live' ? 'Live' : 'Demo'}</span><span>${ov.timed} trains with live times · average +${ov.avg ?? 0} · <span class="c-mid">${ov.late5} 5+ late</span>${ov.cancelled ? ` · <span class="c-bad">${ov.cancelled} cancelled</span>` : ''}</span></div>` : ''}</header>
    <section class="list dl"><div class="list-h">Main lines · tap for the Route tab</div>${lines.length ? bars(lines) : '<div class="empty">Finding trains…</div>'}</section>
    <section class="list dl"><div class="list-h">Train companies</div>${ops ? (ops.length ? bars(ops) : '<div class="empty">No trains with live times right now.</div>') : dlData === false ? '<div class="empty">Available when the live feed is connected.</div>' : '<div class="empty">Loading…</div>'}</section>
    <p class="note">Each average is over trains running now with a live report; early trains count as on time. Network Rail regions aren't shown yet: the live feeds don't say which region a train is in, and placing them by map would be a guess.</p>`;
}
async function loadDelays() {
  const r = await api.delays().catch(() => null);
  dlData = r && r.operators ? r : false;
  renderDelays();
}

function pageShown(name) {
  page = name;
  el.querySelectorAll('.np-nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.np === name)));
  clearInterval(tube.timer); tube.timer = null;
  if (name === 'tube') { loadTube(); tube.timer = setInterval(() => { if (!el.hidden && !document.hidden && page === 'tube') loadTube(); }, 20000); }
  if (name === 'status') api.tflStatus().then((r) => { stData = r || { lines: [] }; renderStatus(); });
  if (name === 'delays') loadDelays();
}
export function showNetworkPage(name, smooth = true) {
  if (!el) return;
  const pager = el.querySelector('.np-pager'), pg = $p(name);
  if (!pager || !pg) return;
  pager.scrollTo({ left: pg.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
  pageShown(name);
}
function fitPager() {
  const pager = el && el.querySelector('.np-pager');
  if (!pager || el.hidden) return;
  const tabs = document.querySelector('.tabs');
  pager.style.height = Math.max(240, window.innerHeight - pager.getBoundingClientRect().top - (tabs ? tabs.offsetHeight : 0)) + 'px';
  const pg = $p(page); if (pg) pager.scrollLeft = pg.offsetLeft;
}
window.addEventListener('resize', () => setTimeout(fitPager, 200));

export function showNetwork(container, handlers) {
  el = container;
  onTrain = handlers.train; onStation = handlers.station;
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.innerHTML = `<nav class="np-nav" role="tablist">${PAGES.map(([k, n]) => `<button role="tab" data-np="${k}" aria-current="${k === page}">${esc(n)}</button>`).join('')}</nav>
      <div class="np-pager">${PAGES.map(([k]) => `<section class="np-page" data-p="${k}"></section>`).join('')}</div>`;
    const pager = el.querySelector('.np-pager');
    // swiping: when the pager settles on a page, load that page
    let t = null;
    pager.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
        const name = (PAGES[i] || PAGES[0])[0];
        if (name !== page) pageShown(name);
      }, 120);
    }, { passive: true });
    el.addEventListener('click', (e) => {
      const nb = e.target.closest('[data-np]');
      if (nb) return showNetworkPage(nb.dataset.np);
      const tln = e.target.closest('[data-tline]');
      if (tln) { if (tln.dataset.nodraw) { stOpen.add(tln.dataset.tline); return showNetworkPage('status'); } return focusLine(tln.dataset.tline); }
      const ls = e.target.closest('[data-ls]');
      if (ls && ls.closest('.np-page')) { const id = ls.dataset.ls; if (stOpen.has(id)) stOpen.delete(id); else stOpen.add(id); return renderStatus(); }
      const tl = e.target.closest('[data-tfl]');
      if (tl) { stOpen.add(tl.dataset.tfl); return showNetworkPage('status'); }
      if (e.target.closest('[data-tflall]')) return showNetworkPage('status');
      const rt = e.target.closest('[data-route]');
      if (rt) {
        const l = LINES.find((x) => x.id === rt.dataset.route);
        if (l) window.dispatchEvent(new CustomEvent('mtt:route', { detail: { route: { id: 'net-' + l.id, name: l.name, crs: l.crs }, train: l.name, quiet: true } }));
        return;
      }
      const tr = e.target.closest('[data-train]');
      if (tr) { const tt = tube.trains.find((x) => x.id === tr.dataset.train); if (tt && onTrain) onTrain(tt); return; }
      const sg = e.target.closest('[data-seg]');
      if (sg) return segSheet(sg.dataset.seg);
      const st = e.target.closest('[data-crs]');
      if (st && onStation) onStation(st.dataset.crs);
    });
  }
  render();
  renderTube();
  requestAnimationFrame(() => { fitPager(); pageShown(page); });
  if (!state.at || Date.now() - state.at > 30000) refresh().then(render);
  api.tflStatus().then((r) => { if (r && r.lines) { tflLines = r.lines; render(); } });
  if (!timer) timer = setInterval(() => { if (!el.hidden && !document.hidden) refresh().then(render); }, 60000);
}
