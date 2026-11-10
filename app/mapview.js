// The Map tab: a real zoomable map of every train, a station search, a
// "where am I" arrow, station boards, and areas to keep an eye on.
// Zoomed out you see every train as a dot coloured by delay; zoom in and
// they become headcode chips, and stations appear.

import * as api from './api.js';
import { STATIONS } from './stations.js';
import { BY_CRS, nearest, searchStations } from './geo.js';
import { routeFromStops } from './route.js';
import { opBadge, esc, hhmm, lateText, shortLate, bandOf, openSheet, updateSheet, sheetOpen, closeCustomSheet, loadList, saveList, toast, boardHTML, luBoardHTML, textOn } from './ui.js';

const AREAS_KEY = 'mtt.areas';
const STATIONS_KEY = 'mtt.stations';
const COLORS = { ok: '#8FB0F0', mid: '#F59E42', bad: '#F2555A', none: '#C9D3E8' };
const CHIP_ZOOM = 11;      // headcode chips from here in
const STATION_ZOOM = 11;   // station dots from here in
const LABEL_ZOOM = 13;     // station names from here in

let map, trainLayer, stationLayer, meLayer, pathLayer, luLineLayer;
let started = false;
let refreshTimer, sheetTimer;

export function showMap() {
  if (!started) start();
  setTimeout(() => map.invalidateSize(), 0);
}

function start() {
  started = true;
  if (!window.L) {
    document.getElementById('map').innerHTML = '<div class="empty" style="padding:24px">The map could not load. Check your connection and reopen the app.</div>';
    return;
  }
  map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 17, worldCopyJump: false })
    .setView([53.0, -1.6], 6);
  // OpenStreetMap's free map, darkened to navy in style.css (.leaflet-tile-pane)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.createPane('lulines').style.zIndex = 390; // Tube lines sit under the stops and trains
  luLineLayer = L.layerGroup().addTo(map);
  stationLayer = L.layerGroup().addTo(map);
  pathLayer = L.layerGroup().addTo(map);
  trainLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);
  map.on('moveend', () => { drawStations(); loadTrains(); });
  map.on('zoomend', drawLuLines);
  drawLuLines();
  refreshTimer = setInterval(loadTrains, 15000);
  loadTrains();
  wireSearch();
  document.getElementById('locate').addEventListener('click', locate);
  document.getElementById('zoom-in').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => map.zoomOut());
  drawAreas();
}

// ---------- London Underground view ----------
// The main map is the railway; the LU button switches the map to Tube, DLR and trams only.
let luMode = false;
try { luMode = localStorage.getItem('mtt.lu') === '1'; } catch { /* default off */ }
const luBtn = document.getElementById('lu-btn');
function setLu(on) {
  luMode = on;
  try { localStorage.setItem('mtt.lu', on ? '1' : '0'); } catch { /* not saved */ }
  luBtn.setAttribute('aria-pressed', String(on));
  luBtn.setAttribute('aria-label', on ? 'Back to the railway map' : 'Show the London Underground only');
  document.body.classList.toggle('lu-mode', on);
  drawLinePicker();
  if (selected) clearSelection();
  if (!map) return;
  // jump to London the first time the Tube view is opened somewhere else
  if (on && !L.latLngBounds([[51.28, -0.6], [51.72, 0.35]]).contains(map.getCenter())) map.setView([51.512, -0.12], 12);
  drawLuLines();
  drawStations();
  loadTrains();
}

// The Tube lines drawn in their own colours, from TfL's route data (only in the LU view)
let luShapes = null;
async function drawLuLines() {
  if (!map || !luLineLayer) return;
  luLineLayer.clearLayers();
  if (!luMode) return;
  if (!luShapes) { luShapes = await api.tflLines().catch(() => null); if (!luShapes || !luMode) return; luLineLayer.clearLayers(); }
  const z = map.getZoom(), w = z >= 15 ? 6 : z >= 13 ? 4.5 : 3;
  for (const l of luShapes.lines || []) {
    if (luLines.length && !luLines.includes(l.id)) continue;
    for (const p of l.paths) L.polyline(p, { pane: 'lulines', color: l.color, weight: w, opacity: luLines.length ? 0.95 : 0.8, interactive: false }).addTo(luLineLayer);
  }
}
// Line filter: pick up to 3 lines to show on their own (none picked = every line)
const LU_LINES = {
  bakerloo: { short: 'BAK', name: 'Bakerloo', color: '#B36305' }, central: { short: 'CEN', name: 'Central', color: '#E32017' },
  circle: { short: 'CIR', name: 'Circle', color: '#FFD300' }, district: { short: 'DIS', name: 'District', color: '#00782A' },
  'hammersmith-city': { short: 'H&C', name: 'Hammersmith & City', color: '#F3A9BB' }, jubilee: { short: 'JUB', name: 'Jubilee', color: '#A0A5A9' },
  metropolitan: { short: 'MET', name: 'Metropolitan', color: '#9B0056' }, northern: { short: 'NOR', name: 'Northern', color: '#000000' },
  piccadilly: { short: 'PIC', name: 'Piccadilly', color: '#003688' }, victoria: { short: 'VIC', name: 'Victoria', color: '#0098D4' },
  'waterloo-city': { short: 'W&C', name: 'Waterloo & City', color: '#95CDBA' }, dlr: { short: 'DLR', name: 'DLR', color: '#00A4A7' },
  tram: { short: 'TRM', name: 'Trams', color: '#84B817' }
};
const MAX_LINES = 3;
let luLines = [];
try { luLines = JSON.parse(localStorage.getItem('mtt.lulines') || '[]').filter((l) => LU_LINES[l]).slice(0, MAX_LINES); } catch { /* none */ }
const $lines = document.getElementById('lu-lines');
// little "hats" above and below the list when there are more lines to scroll to
const $up = document.getElementById('lu-up'), $down = document.getElementById('lu-down');
function moreArrows() {
  const can = luMode && !$lines.hidden;
  $up.hidden = !can || $lines.scrollTop <= 2;
  $down.hidden = !can || $lines.scrollTop + $lines.clientHeight >= $lines.scrollHeight - 2;
}
$lines.addEventListener('scroll', moreArrows, { passive: true });
window.addEventListener('resize', moreArrows);
if (window.ResizeObserver) new ResizeObserver(moreArrows).observe($lines); // e.g. coming back to the Map tab
$up.addEventListener('click', () => $lines.scrollBy({ top: -$lines.clientHeight * 0.7, behavior: 'smooth' }));
$down.addEventListener('click', () => $lines.scrollBy({ top: $lines.clientHeight * 0.7, behavior: 'smooth' }));
function drawLinePicker() {
  $lines.hidden = !luMode;
  requestAnimationFrame(moreArrows);
  if (!luMode) return;
  $lines.innerHTML = `<button class="lul all" data-line="" aria-pressed="${!luLines.length}">All</button>` +
    Object.entries(LU_LINES).map(([id, l]) => `<button class="lul" data-line="${id}" aria-pressed="${luLines.includes(id)}" aria-label="${esc(l.name)}" style="--lc:${l.color};--lt:${textOn(l.color)}"><i></i>${esc(l.short)}</button>`).join('');
}
$lines.addEventListener('click', (e) => {
  const b = e.target.closest('[data-line]');
  if (!b) return;
  const id = b.dataset.line;
  if (!id) luLines = [];
  else if (luLines.includes(id)) luLines = luLines.filter((x) => x !== id);
  else if (luLines.length >= MAX_LINES) { toast(`Up to ${MAX_LINES} lines at a time. Tap one to remove it.`); return; }
  else luLines = [...luLines, id];
  try { localStorage.setItem('mtt.lulines', JSON.stringify(luLines)); } catch { /* not saved */ }
  if (selected && luLines.length && selected.line && !luLines.includes(selected.line)) clearSelection();
  drawLinePicker();
  if (map) { drawLuLines(); drawStations(); if (lastRes) drawTrains(lastRes); }
});

luBtn.addEventListener('click', () => { window.dispatchEvent(new CustomEvent('mtt:maptab')); setLu(!luMode); });
luBtn.setAttribute('aria-pressed', String(luMode));
document.body.classList.toggle('lu-mode', luMode);
drawLinePicker();

// ---------- trains ----------
let loading = false;
async function loadTrains() {
  if (loading || !map) return;
  loading = true;
  try {
    const b = map.getBounds();
    const res = await api.trains({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }, undefined, luMode ? 'tfl' : undefined);
    drawTrains(res);
  } catch { /* keep the last picture */ }
  loading = false;
}

let lastRes = null;
function drawTrains(res) {
  if (res && res.error) {
    // Never leave old positions up as if they were current
    lastRes = null;
    trainLayer.clearLayers();
    document.getElementById('map-count').innerHTML = `<span class="pill wait c-bad">${res.offline ? 'Offline' : 'No data'}</span> ${esc(res.error)}`;
    return;
  }
  lastRes = res;
  trainLayer.clearLayers();
  const z = map.getZoom();
  const list = (res.trains || []).filter((t) => !luMode || !luLines.length || luLines.includes(t.line));
  if (z >= CHIP_ZOOM) {
    // Trains drawn on top of each other (e.g. waiting at the same station) become one bubble
    // the selected train always gets its own chip, on top
    const sel = selected && list.find((t) => t.id === selected.id);
    for (const group of groupByScreen(list.filter((t) => t !== sel), 34)) {
      if (group.length === 1) drawChip(group[0]);
      else drawGroup(group);
    }
    if (sel) drawChip(sel);
  } else {
    for (const t of list) {
      const c = t.color || COLORS[t.band] || COLORS.none;
      const sel = selected && selected.id === t.id;
      L.circleMarker([t.lat, t.lon], { radius: sel ? 8 : z <= 7 ? 3 : 5, color: sel ? '#E3B53A' : '#0C1B38', weight: sel ? 3 : 1, fillColor: c, fillOpacity: 0.95 })
        .on('click', () => selectTrain(t)).addTo(trainLayer);
    }
  }
  const count = document.getElementById('map-count');
  const total = luMode && luLines.length ? list.length : res.total || 0;
  const shown = list.length < total ? `${list.length} of ${total}` : `${list.length}`;
  const late = list.filter((t) => t.band === 'mid' || t.band === 'bad').length;
  count.innerHTML = `<span class="pill ${res.mode === 'live' ? 'live' : 'demo'}">${res.mode === 'live' ? 'Live' : 'Demo'}</span> ${luMode ? (luLines.length ? esc(luLines.map((l) => LU_LINES[l].short).join(' · ')) + ' · ' : 'Underground · ') : ''}${shown} train${total === 1 ? '' : 's'} in view${luMode ? '' : ` · <span class="c-mid">${late} late</span>`}${list.length < total ? ' · zoom in for all' : ''}<span class="chev" aria-hidden="true">▾</span>`;
}

function groupByScreen(list, px) {
  const groups = [];
  for (const t of list) {
    const pt = map.latLngToContainerPoint([t.lat, t.lon]);
    const g = groups.find((x) => Math.abs(x.pt.x - pt.x) < px * 3.4 && Math.abs(x.pt.y - pt.y) < px * 1.2);
    if (g) g.items.push(t); else groups.push({ pt, items: [t] });
  }
  return groups.map((g) => g.items);
}

const RANK = { bad: 3, mid: 2, ok: 1, none: 0 };
function drawChip(t) {
  const c = COLORS[t.band] || COLORS.none;
  const icon = L.divIcon({
    className: 'tchip-wrap',
    // TfL trains have no "minutes late": they carry their line's colour instead
    html: t.color
      ? `<span class="tchip line${selected && selected.id === t.id ? ' sel' : ''}"><b style="background:${t.color};color:${['#FFD300', '#F3A9BB', '#A0A5A9', '#95CDBA', '#84B817'].includes(t.color) ? '#0B0D12' : '#FFFFFF'}">${esc(t.code)}</b><i>${esc(t.next ? '→ ' + t.next : '')}</i></span>`
      : `<span class="tchip${selected && selected.id === t.id ? ' sel' : ''}"><b>${esc(t.code)}</b><i style="background:${c}">${esc(shortLate(t.delay, t.cancelled))}</i></span>`,
    iconSize: null, iconAnchor: [0, 14]
  });
  L.marker([t.lat, t.lon], { icon, keyboard: true, title: t.color ? `${t.toc} line train, ${t.last || ''}` : `${t.code} ${lateText(t.delay, t.cancelled)}` })
    .on('click', () => selectTrain(t)).addTo(trainLayer);
}

function drawGroup(items) {
  const worst = items.reduce((w, t) => (RANK[t.band] > RANK[w.band] ? t : w), items[0]);
  const late = items.filter((t) => t.band === 'mid' || t.band === 'bad').length;
  const lat = items.reduce((s, t) => s + t.lat, 0) / items.length, lon = items.reduce((s, t) => s + t.lon, 0) / items.length;
  const icon = L.divIcon({
    className: 'tchip-wrap',
    html: `<span class="tgroup"><b>${items.length} trains</b>${late ? `<i style="background:${COLORS[worst.band]}">${late} late</i>` : ''}</span>`,
    iconSize: null, iconAnchor: [0, 14]
  });
  L.marker([lat, lon], { icon, keyboard: true, title: `${items.length} trains here` })
    .on('click', () => groupSheet(items)).addTo(trainLayer);
}

// The trains-in-view list behind the Live pill: most late first, capped when zoomed out
const LIST_CAP = 50;
function listSheet() {
  if (!lastRes) return;
  const all = [...(lastRes.trains || [])].sort((a, b) => RANK[b.band] - RANK[a.band] || (b.delay ?? 0) - (a.delay ?? 0) || a.code.localeCompare(b.code));
  const items = all.slice(0, LIST_CAP);
  const more = (lastRes.total || all.length) - items.length;
  const rows = items.map((t) => {
    const bd = bandOf(t.delay, t.cancelled);
    const where = t.dest ? 'to ' + t.dest : t.next ? 'next ' + t.next : t.last ? 'at ' + t.last : '';
    return `<button class="row" data-act="train" data-arg="${esc(t.id)}"><span class="hc b-${bd}">${esc(t.code)}</span>
      <span class="what">${esc(where)}${t.toc ? `<small class="sub-line">${opBadge(t.toc)}${esc(t.toc)}</small>` : ''}</span><span class="mins c-${bd}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`;
  }).join('');
  openSheet(`<div class="st-head"><div><div class="meta">${lastRes.mode === 'live' ? 'Live' : 'Demo'} · ${luMode ? 'London Underground' : 'most late first'}</div><h2 id="sheet-title">${lastRes.total || 0} trains in view</h2></div></div>
    <div class="sheet-body list flush">${rows || '<div class="empty">No trains in view. Zoom out or move the map.</div>'}
    ${more > 0 ? `<p class="note">Showing the ${items.length} most late. Zoom in to see the other ${more}.</p>` : ''}</div>`, {
    train: (id) => { const t = items.find((x) => x.id === id); if (t) { closeCustomSheet(); selectTrain(t); } }
  }, null, luMode ? 'lu' : null);
}
document.getElementById('map-count').addEventListener('click', listSheet);

function groupSheet(items) {
  const here = items[0].last;
  const rows = [...items].sort((a, b) => RANK[b.band] - RANK[a.band] || (b.delay ?? 0) - (a.delay ?? 0)).map((t) => {
    const bd = bandOf(t.delay, t.cancelled);
    return `<button class="row" data-act="train" data-arg="${esc(t.id)}"><span class="hc b-${bd}">${esc(t.code)}</span>
      <span class="what">${esc(t.dest ? 'to ' + t.dest : t.next ? 'next ' + t.next : 'at ' + t.last)}${t.toc ? `<small class="sub-line">${opBadge(t.toc)}${esc(t.toc)}</small>` : ''}</span><span class="mins c-${bd}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`;
  }).join('');
  openSheet(`<div class="st-head"><div><div class="meta">${items.length} trains</div><h2 id="sheet-title">${esc(here ? 'At or near ' + here : 'Trains here')}</h2></div></div>
    <div class="sheet-body list flush">${rows}</div>`, {
    train: (id) => { const t = items.find((x) => x.id === id); if (t) { closeCustomSheet(); selectTrain(t); } }
  }, null, luMode ? 'lu' : null);
}

// ---------- selecting a train: its route so far on the map ----------
// First tap: the stations it has reported at since it started, joined up and highlighted.
// Tap it again (or its headcode in the bar) for the full train screen. "Clear map" removes it.
let selected = null, selTimer = null;
function selectTrain(t, open = false) {
  if (selected && selected.id === t.id && !open) return trainSheet(t);
  selected = t;
  drawSelBar(null);
  loadPath(true);
  clearInterval(selTimer);
  selTimer = setInterval(() => loadPath(false), 30000);
  if (lastRes) drawTrains(lastRes);
  if (open) trainSheet(t);
}
// From any train screen: show this train on the map, with its route so far
export function focusTrain(t) {
  if (!started) start();
  setTimeout(() => { map.invalidateSize(); selected = null; selectTrain(t); }, 50);
}
async function loadPath(fit) {
  if (!selected) return;
  const id = selected.id;
  const d = await api.train(id).catch(() => null);
  if (!selected || selected.id !== id) return;
  pathLayer.clearLayers();
  const pts = d && !d.error && d.path ? d.path : [];
  // where it is now, if it has moved on from the last reported station
  const now = lastRes && (lastRes.trains || []).find((x) => x.id === id);
  const line = pts.map((p) => [p.lat, p.lon]);
  if (now && (!line.length || line[line.length - 1][0] !== now.lat || line[line.length - 1][1] !== now.lon)) line.push([now.lat, now.lon]);
  if (line.length > 1) {
    L.polyline(line, { color: '#0C1B38', weight: 9, opacity: 0.9, interactive: false }).addTo(pathLayer);
    L.polyline(line, { color: '#E3B53A', weight: 4.5, opacity: 1, interactive: false }).addTo(pathLayer);
  }
  pts.forEach((p, i) => {
    L.circleMarker([p.lat, p.lon], { radius: i === 0 ? 7 : 4.5, color: '#E3B53A', weight: 2, fillColor: i === 0 ? '#E3B53A' : '#0C1B38', fillOpacity: 1 })
      .bindTooltip(`${p.name}${p.at ? ' · ' + hhmm(p.at) : ''}`, { direction: 'top', offset: [0, -6], className: 'stn-label' })
      .addTo(pathLayer);
  });
  drawSelBar(d && !d.error ? d : null, pts);
  if (fit && line.length) map.flyToBounds(L.latLngBounds(line).pad(0.25), { maxZoom: 13, duration: 0.6 });
  else if (fit && selected.lat != null) map.flyTo([selected.lat, selected.lon], 13, { duration: 0.6 });
}
function drawSelBar(d, pts = []) {
  const bar = document.getElementById('sel-bar');
  if (!selected) { bar.hidden = true; bar.innerHTML = ''; return; }
  const t = selected;
  const bd = bandOf(d ? d.delay : t.delay, d ? d.cancelled : t.cancelled);
  const from = (d && d.origin) || t.origin || (pts[0] && pts[0].name);
  const what = !d ? 'Loading its route…'
    : pts.length ? `From ${esc(from || pts[0].name)} · ${pts.length} station${pts.length === 1 ? '' : 's'} reported`
    : 'No station reports for this train yet';
  bar.innerHTML = `<button class="sel-hc b-${bd}" data-sel="open" aria-label="Open ${esc(t.code)}">${esc(t.code)}</button>
    <span class="sel-what">${what}<small>Tap the headcode for details</small></span>
    <button class="sel-clear" data-sel="clear">Clear map</button>`;
  bar.hidden = false;
}
function clearSelection() {
  selected = null;
  clearInterval(selTimer);
  pathLayer.clearLayers();
  drawSelBar();
  if (lastRes) drawTrains(lastRes);
}
document.getElementById('sel-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  if (b.dataset.sel === 'clear') clearSelection();
  else if (selected) trainSheet(selected);
});

// A board row as a train for the train screen, looked up from the board itself
// Is this an Underground/DLR/tram train or stop? Those get the LU colours.
export const isLu = (t) => !!t && (t.country === 'tfl' || /^tflp?:/.test(t.id || '') || /^tflp?:/.test((t.boardRef && t.boardRef.id) || ''));
const isLuStation = (crs) => (BY_CRS.get(crs) || {}).country === 'tfl';

export function boardTrain(row, crs, type, back) {
  return { id: null, code: row.headcode || '', delay: row.delay, cancelled: row.cancelled, toc: row.toc,
    dest: type === 'dep' ? row.place : null, origin: type === 'arr' ? row.place : null,
    boardRef: { crs, type, id: row.id }, back: back || null, line: row.line || null, color: row.lineColor || null };
}

// "14:32", "14:37" -> 5, across midnight; null if either is missing
function minsLate(booked, actual) {
  const m = (x) => { const r = /^(\d\d):(\d\d)/.exec(x || ''); return r ? Number(r[1]) * 60 + Number(r[2]) : null; };
  const b = m(booked), a = m(actual);
  if (b == null || a == null) return null;
  let d = a - b;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

// ---------- the train screen: from, to, next stop, on time, every stop ----------
export async function trainSheet(t) {
  clearInterval(sheetTimer);
  let d = null;
  let detailed = false;
  const html = () => {
    const delay = d && d.delay !== undefined ? d.delay : t.delay, cancelled = d && d.cancelled !== undefined ? d.cancelled : t.cancelled;
    const bd = bandOf(delay, cancelled);
    const origin = (d && d.origin) || t.origin, dest = (d && d.dest) || t.dest;
    const title = origin && dest ? `${esc(origin)} → ${esc(dest)}` : dest ? `To ${esc(dest)}` : origin ? `From ${esc(origin)}` : 'Train ' + esc(t.code);
    const op = (d && d.operator) || t.toc;
    let next = '';
    if (d && d.next) {
      next = `<div class="nextstop"><span class="lbl">Next stop</span><b>${esc(d.next.name)}</b><span class="c-${bd}">${d.next.expected && d.next.expected !== d.next.booked ? `exp ${esc(d.next.expected)} <s>${esc(d.next.booked)}</s>` : esc(d.next.booked || '')}${d.next.platform ? ' · Plat ' + esc(d.next.platform) : ''}</span></div>`;
    } else if (d && d.terminated) {
      next = `<div class="nextstop"><span class="lbl">Journey</span><b>Arrived at ${esc(dest || t.last)}</b></div>`;
    } else if (!d || !d.matched) {
      const nx = (d && d.nextReport) || t.next;
      next = `<div class="nextstop"><span class="lbl">${nx ? 'Next timing point' : 'Last seen'}</span><b>${esc(nx || t.last || '–')}</b></div>`;
    }
    const last = (d && d.last) || (t.last ? { name: t.last, event: t.lastEvent, at: t.lastAt } : null);
    const shown = d && d.stops ? d.stops.filter((s) => detailed || !s.pass) : [];
    const passCount = d && d.stops ? d.stops.filter((s) => s.pass).length : 0;
    const stops = shown.length ? `<div class="stops">${shown.map((s) => {
      const isNext = d.next && s === d.next;
      const cls = [s.state === 'passed' ? 'passed' : '', isNext ? 'next' : '', s.cancelled ? 'cancelled' : '', s.pass ? 'pass' : ''].join(' ');
      const actual = typeof s.actual === 'number' ? hhmm(s.actual) : s.actual;
      let right;
      if (s.cancelled || (d.cancelled && s.state !== 'passed')) right = '<span class="c-bad">Cancelled</span>';
      else if (s.state === 'passed') {
        // the time it actually got there and how late it was at that point
        const late = typeof s.late === 'number' ? s.late : minsLate(s.pass ? (s.working || s.booked) : s.booked, actual);
        const lb = late == null || !actual ? '' : `<small class="c-${bandOf(late)}">${late >= 1 ? '+' + late : late <= -1 ? -late + ' early' : 'On time'}</small>`;
        right = actual ? `${esc(actual)}${lb}` : '<small class="c-none">No report</small>';
      }
      else if (s.expected && s.expected !== s.booked && /\d/.test(s.expected)) right = `<span class="c-${bd}">${esc(s.expected)}</span>`;
      else if (s.expected === 'Delayed') right = '<span class="c-mid">Delayed</span>';
      else right = s.pass ? 'pass' : 'On time';
      const plat = s.platform ? `Plat ${esc(s.platform)}` : s.hiddenPlatform ? `Plat ${esc(s.hiddenPlatform)} <em>(not shown to public)</em>` : '';
      const booked = s.pass ? (s.working || s.booked || '') : (s.booked || '');
      return `<div class="stop ${cls}"><i></i><span class="sn">${esc(s.name)}${s.pass ? '<small>passes</small>' : plat ? `<small>${plat}</small>` : ''}</span><span class="sb">${esc(booked)}</span><span class="sa">${right}</span></div>`;
    }).join('')}</div>` : (d && d.note ? `<p class="note">${esc(d.note)}</p>` : '');
    const extras = d ? [
      d.length || d.firstClass ? esc([d.length ? d.length + ' coaches' : null, d.firstClass].filter(Boolean).join(' · ')) : null,
      d.cancelReason ? esc(d.cancelReason) : d.delayReason ? esc(d.delayReason) : null
    ].filter(Boolean) : [];
    const toggle = passCount ? `<button class="detail-toggle" data-act="detail" aria-pressed="${detailed}">${detailed ? 'Hide' : 'Show'} ${passCount} passing point${passCount === 1 ? '' : 's'}</button>` : '';
    const source = d && d.source === 'darwin' ? '<p class="credit">Stops ahead live from National Rail</p>' : d && d.liveNote ? `<p class="credit">${esc(d.liveNote)}</p>` : '';
    const code = (d && d.code) || t.code || '';
    // Tube trains: the line's colour and code in place of minutes late (the Tube has no per-train timetable)
    const ln = isLu(t) && LU_LINES[t.line] ? LU_LINES[t.line] : null;
    const bigBox = ln ? `<div class="big lu-big" style="background:${ln.color};color:${textOn(ln.color)}">${esc(ln.short)}</div>` : `<div class="big b-${bd}">${esc(shortLate(delay, cancelled))}</div>`;
    const sub = ln ? `<p class="c-none">${esc(ln.name)}${/DLR|Trams/.test(ln.name) ? '' : ' line'} · live predictions</p>` : `<p class="c-${bd === 'none' ? 'none' : bd}">${esc(lateText(delay, cancelled))}</p>`;
    return `${t.back ? '<button class="back-link" data-act="back">‹ Back to the board</button>' : ''}<div class="sheet-top">${bigBox}
      <div><div class="meta">${esc(code)}${op ? ' · ' + opBadge(op, d && d.operatorCode) + esc(op) : ''}</div><h2 id="sheet-title">${title}</h2>${sub}</div></div>
      ${next}
      ${last ? `<p class="lastseen">${esc(last.event || 'Seen')} ${esc(last.name)}${last.at ? ' at ' + hhmm(last.at) : ''}</p>` : ''}
      ${extras.map((x) => `<p class="lastseen">${x}</p>`).join('')}
      <div class="sheet-body">${!d ? '<div class="empty">Loading stops…</div>' : stops + toggle + source}</div>
      <div class="sheet-actions">${t.id ? '<button data-act="onmap">Show on map</button>' : ''}${d && d.stops && routeFromStops(d.stops) ? '<button data-act="route">Make this my route</button>' : ''}</div>`;
  };
  const load = async () => {
    if (t.boardRef) {
      const r = t.boardRef;
      d = await api.service(r.crs, r.type, r.id).catch(() => null);
      if (d && d.natId) t.id = d.natId; // the train we're tracking: lets it be shown on the map
    } else d = await api.train(t.id).catch(() => null);
    if (d && d.error) { if (t.boardRef && sheetOpen()) updateSheet(html().replace('Loading stops…', esc(d.error))); d = null; return; }
    if (sheetOpen()) updateSheet(html());
  };
  openSheet(html(), {
    detail: () => { detailed = !detailed; updateSheet(html()); },
    back: () => { if (t.back) t.back(); },
    onmap: () => { closeCustomSheet(); window.dispatchEvent(new CustomEvent('mtt:showtrain', { detail: { train: t } })); },
    route: () => {
      const origin = (d && d.origin) || t.origin, dest = (d && d.dest) || t.dest;
      const r = routeFromStops(d && d.stops, origin && dest ? `${origin} – ${dest}` : null);
      if (r) { closeCustomSheet(); window.dispatchEvent(new CustomEvent('mtt:route', { detail: { route: r, train: t.code } })); }
    }
  }, () => clearInterval(sheetTimer), isLu(t) ? 'lu' : null, isLu(t) && LU_LINES[t.line] ? LU_LINES[t.line].color : null);
  load();
  sheetTimer = setInterval(load, 30000);
}

// ---------- stations ----------
// Landmark stations named on the Underground map when zoomed out: big interchanges and termini,
// spread across zones 1–2 so you can find your way. Everything else is named when you zoom in.
const LU_KEY = new Set(["king's cross st. pancras", 'euston', 'paddington', 'baker street', 'oxford circus', 'bank', 'liverpool street',
  'waterloo', 'victoria', 'london bridge', 'westminster', 'stratford', 'canary wharf', 'tottenham court road', 'earl\'s court',
  'notting hill gate', 'camden town', 'elephant & castle', 'brixton', 'finsbury park', 'wimbledon', 'hammersmith', 'tower hill', 'green park']);
const luShort = (n) => String(n || '').replace(/\s*\((Underground|DLR|Tram)\)$/, '');

function drawStations() {
  stationLayer.clearLayers();
  const z = map.getZoom();
  if (z < STATION_ZOOM) return;
  const b = map.getBounds();
  const labelled = new Set(); // one label per name (Bank has Underground and DLR stops)
  for (const [crs, name, lat, lon] of STATIONS) {
    if (!b.contains([lat, lon])) continue;
    // railway stations on the main map, Underground/DLR/tram stops in the LU view
    const isTfl = (BY_CRS.get(crs) || {}).country === 'tfl';
    if (isTfl !== luMode) continue;
    if (luMode && luLines.length && !((BY_CRS.get(crs) || {}).lines || []).some((l) => luLines.includes(l))) continue;
    let m;
    if (luMode) {
      // Underground: small white stops; names only for a few landmark stations until zoomed right in.
      // Every stop can still be tapped for its name and board.
      const short = luShort(name);
      // a stop on one line is ringed in that line's colour; an interchange is white with a dark ring
      const st = BY_CRS.get(crs) || {};
      const own = (st.lines || []).filter((l) => !luLines.length || luLines.includes(l));
      const ring = own.length === 1 && LU_LINES[own[0]] ? LU_LINES[own[0]].color : '#0A1240';
      m = L.circleMarker([lat, lon], { radius: z >= 15 ? 5 : 4, color: ring, weight: own.length > 1 ? 2.5 : 3, fillColor: '#FFFFFF', fillOpacity: 1 });
      // with lines chosen there are far fewer stops, so they're all named from zoom 13
      const show = z >= 16 || (luLines.length && z >= 13) || (z >= 15 && (st.nLines || 1) >= 2) || (z >= 12 && LU_KEY.has(short.toLowerCase()));
      if (show && !labelled.has(short)) { labelled.add(short); m.bindTooltip(short, { permanent: true, direction: 'right', offset: [7, 0], className: 'stn-label lu-label' }); }
      else m.bindTooltip(short, { direction: 'top', offset: [0, -6], className: 'stn-label lu-label' });
    } else {
      m = L.circleMarker([lat, lon], { radius: 6, color: '#E3B53A', weight: 2, fillColor: '#0C1B38', fillOpacity: 1 });
      if (z >= LABEL_ZOOM) m.bindTooltip(name, { permanent: true, direction: 'right', offset: [8, 0], className: 'stn-label' });
    }
    m.on('click', () => stationSheet(crs));
    m.addTo(stationLayer);
  }
}

export async function stationSheet(crs, type = 'dep') {
  const st = BY_CRS.get(crs);
  if (!st) return;
  clearInterval(sheetTimer);
  const lu = isLuStation(crs);
  // TfL gives one list of predicted trains, so an Underground station has one board, not two
  let current = lu ? 'dep' : type;
  let bound = null; // Underground: which direction's tab is open
  let data = null;
  const areas = loadList(AREAS_KEY);
  const saved = loadList(STATIONS_KEY);
  const html = () => `
    <div class="st-head"><div><div class="meta">${lu ? esc((/\((Underground|DLR|Tram)\)$/.exec(st.name) || [, 'Underground'])[1]) : esc(crs)}</div><h2 id="sheet-title">${esc(lu ? luShort(st.name) : st.name)}</h2></div></div>
    ${lu ? luView().tabs : `<div class="segctl" role="tablist">
      <button role="tab" data-act="type" data-arg="dep" aria-selected="${current === 'dep'}">Departures</button>
      <button role="tab" data-act="type" data-arg="arr" aria-selected="${current === 'arr'}">Arrivals</button>
    </div>`}
    <div class="sheet-body">${lu ? luView().body : boardHTML(data, current)}</div>
    <div class="sheet-actions">
      <button data-act="watch">${areas.some((a) => a.crs === crs) ? 'Watching area' : 'Watch this area'}</button>
      <button data-act="save">${saved.some((s) => s.crs === crs) ? 'Saved' : 'Save station'}</button>
    </div>
    <div class="sheet-actions one"><button data-act="build">Build a route from here</button></div>`;
  const luView = () => { const v = luBoardHTML(data, bound); if (v.bound) bound = v.bound; return v; };
  async function load() {
    data = await api.board(crs, current).catch((e) => ({ error: e.message }));
    if (sheetOpen()) updateSheet(html());
  }
  openSheet(html(), {
    type: (t) => { current = t; data = null; updateSheet(html()); load(); },
    bound: (b) => { bound = b; updateSheet(html()); },
    watch: () => { watchArea(st); updateSheet(html()); },
    // a train on the board: its own screen, with a way back to this board
    svc: (id) => { const row = data && data.services && data.services.find((x) => x.id === id); if (row) trainSheet(boardTrain(row, crs, current, () => stationSheet(crs, current))); },
    build: () => { closeCustomSheet(); window.dispatchEvent(new CustomEvent('mtt:build', { detail: { crs } })); },
    save: () => {
      const list = loadList(STATIONS_KEY);
      if (!list.some((s) => s.crs === crs)) { list.unshift({ crs, name: st.name }); saveList(STATIONS_KEY, list.slice(0, 12)); toast(`${st.name} saved to Boards`); }
      updateSheet(html());
    }
  }, () => clearInterval(sheetTimer), lu ? 'lu' : null);
  load();
  sheetTimer = setInterval(load, lu ? 30000 : 60000);
}

// ---------- areas to keep an eye on ----------
function watchArea(st) {
  const list = loadList(AREAS_KEY);
  if (!list.some((a) => a.crs === st.crs)) {
    list.push({ crs: st.crs, name: st.name, lat: st.lat, lon: st.lon });
    saveList(AREAS_KEY, list.slice(-8));
    toast(`Watching the ${st.name} area`);
  }
  drawAreas();
}

function drawAreas() {
  const el = document.getElementById('areas');
  const list = loadList(AREAS_KEY);
  el.innerHTML = list.map((a) => `<button class="area-chip" data-crs="${esc(a.crs)}">${esc(a.name)}</button>`).join('');
  el.hidden = !list.length;
}

document.getElementById('areas').addEventListener('click', (e) => {
  const b = e.target.closest('.area-chip');
  if (!b) return;
  const a = loadList(AREAS_KEY).find((x) => x.crs === b.dataset.crs);
  if (a) openArea(a);
});

async function openArea(a) {
  map.flyTo([a.lat, a.lon], 12, { duration: 0.8 });
  clearInterval(sheetTimer);
  let data = null;
  const html = () => {
    const rows = !data ? '<div class="empty">Loading…</div>'
      : data.error ? `<div class="empty">${esc(data.error)}</div>`
      : !data.moves.length ? '<div class="empty">No train movements reported within 15 km in the last hour.</div>'
      : data.moves.map((m) => {
        const bd = bandOf(m.delay);
        return `<button class="mrow" data-act="train" data-arg="${esc(m.id || m.code)}"><span class="btime">${hhmm(m.at)}</span><span class="hc b-${bd}">${esc(m.code)}</span>
          <span class="bplace"><b>${esc(m.event)} ${esc(m.name)}</b><small>${opBadge(m.toc)}${esc([m.dest ? 'to ' + m.dest : null, m.toc].filter(Boolean).join(' · '))}</small></span>
          <span class="mins c-${bd}">${esc(shortLate(m.delay))}</span></button>`;
      }).join('');
    return `<div class="st-head"><div><div class="meta">Watching · 15 km around</div><h2 id="sheet-title">${esc(a.name)}</h2></div></div>
      <div class="sheet-body">${rows}</div>
      <div class="sheet-actions"><button data-act="board">${esc(a.name)} board</button><button data-act="unwatch">Stop watching</button></div>`;
  };
  async function load() {
    data = await api.moves(a.lat, a.lon, 15).catch((e) => ({ error: e.message }));
    if (sheetOpen()) updateSheet(html());
  }
  openSheet(html(), {
    board: () => stationSheet(a.crs),
    // first tap: show the train's route so far on the map; tap again for its details
    train: (id) => {
      const m = data && data.moves && data.moves.find((x) => (x.id || x.code) === id);
      if (!m) return;
      closeCustomSheet();
      selectTrain({ id, code: m.code, delay: m.delay, toc: m.toc, dest: m.dest, last: m.name });
    },
    unwatch: () => { saveList(AREAS_KEY, loadList(AREAS_KEY).filter((x) => x.crs !== a.crs)); drawAreas(); closeCustomSheet(); }
  }, () => clearInterval(sheetTimer));
  load();
  sheetTimer = setInterval(load, 20000);
}

// ---------- search ----------
function wireSearch() {
  const input = document.getElementById('map-q');
  const list = document.getElementById('map-results');
  const show = () => {
    const hits = searchStations(input.value);
    list.innerHTML = hits.map((h) => `<li><button data-crs="${h.crs}"><b>${esc(h.name)}</b><small>${h.crs}</small></button></li>`).join('');
    list.hidden = !hits.length;
  };
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = list.querySelector('button'); if (first) first.click(); }
    if (e.key === 'Escape') { list.hidden = true; input.blur(); }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-crs]');
    if (!b) return;
    const st = BY_CRS.get(b.dataset.crs);
    input.value = st.name;
    list.hidden = true;
    input.blur();
    map.flyTo([st.lat, st.lon], 13, { duration: 0.8 });
    stationSheet(st.crs);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.map-search')) list.hidden = true; });
}

// ---------- where am I ----------
function locate() {
  if (!navigator.geolocation) return toast('This browser cannot share your location.');
  const btn = document.getElementById('locate');
  btn.classList.add('busy');
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.classList.remove('busy');
    const { latitude: lat, longitude: lon } = pos.coords;
    meLayer.clearLayers();
    L.circleMarker([lat, lon], { radius: 8, color: '#FFFFFF', weight: 3, fillColor: '#2F80FF', fillOpacity: 1 }).addTo(meLayer);
    map.flyTo([lat, lon], 13, { duration: 0.8 });
    const n = nearest(lat, lon, 1)[0];
    if (n) toast(`Nearest station: ${n.name} (${n.km.toFixed(1)} km)`);
  }, (err) => {
    btn.classList.remove('busy');
    toast(err.code === 1 ? 'Location is turned off for this app. Allow it in Settings › Safari › Location.' : 'Could not find your location just now.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}
