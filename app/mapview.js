// The Map tab: a real zoomable map of every train, a station search, a
// "where am I" arrow, station boards, and areas to keep an eye on.
// Zoomed out you see every train as a dot coloured by delay; zoom in and
// they become headcode chips, and stations appear.

import * as api from './api.js';
import { STATIONS } from './stations.js';
import { BY_CRS, nearest, searchStations } from './geo.js';
import { routeFromStops } from './route.js';
import { esc, hhmm, lateText, shortLate, bandOf, openSheet, updateSheet, sheetOpen, closeCustomSheet, loadList, saveList, toast, boardHTML } from './ui.js';

const AREAS_KEY = 'mtt.areas';
const STATIONS_KEY = 'mtt.stations';
const COLORS = { ok: '#8FB0F0', mid: '#F59E42', bad: '#F2555A', none: '#C9D3E8' };
const CHIP_ZOOM = 11;      // headcode chips from here in
const STATION_ZOOM = 11;   // station dots from here in
const LABEL_ZOOM = 13;     // station names from here in

let map, trainLayer, stationLayer, meLayer;
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
  stationLayer = L.layerGroup().addTo(map);
  trainLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);
  map.on('moveend', () => { drawStations(); loadTrains(); });
  refreshTimer = setInterval(loadTrains, 15000);
  loadTrains();
  wireSearch();
  document.getElementById('locate').addEventListener('click', locate);
  document.getElementById('zoom-in').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => map.zoomOut());
  drawAreas();
}

// ---------- trains ----------
let loading = false;
async function loadTrains() {
  if (loading || !map) return;
  loading = true;
  try {
    const b = map.getBounds();
    const res = await api.trains({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() });
    drawTrains(res);
  } catch { /* keep the last picture */ }
  loading = false;
}

let lastRes = null;
function drawTrains(res) {
  lastRes = res;
  trainLayer.clearLayers();
  const z = map.getZoom();
  const list = res.trains || [];
  if (z >= CHIP_ZOOM) {
    // Trains drawn on top of each other (e.g. waiting at the same station) become one bubble
    for (const group of groupByScreen(list, 34)) {
      if (group.length === 1) drawChip(group[0]);
      else drawGroup(group);
    }
  } else {
    for (const t of list) {
      const c = COLORS[t.band] || COLORS.none;
      L.circleMarker([t.lat, t.lon], { radius: z <= 7 ? 3 : 5, color: '#0C1B38', weight: 1, fillColor: c, fillOpacity: 0.95 })
        .on('click', () => trainSheet(t)).addTo(trainLayer);
    }
  }
  const count = document.getElementById('map-count');
  const shown = list.length < (res.total || 0) ? `${list.length} of ${res.total}` : `${list.length}`;
  const late = list.filter((t) => t.band === 'mid' || t.band === 'bad').length;
  count.innerHTML = `<span class="pill ${res.mode === 'live' ? 'live' : 'demo'}">${res.mode === 'live' ? 'Live' : 'Demo'}</span> ${shown} train${res.total === 1 ? '' : 's'} in view · <span class="c-mid">${late} late</span>${list.length < (res.total || 0) ? ' · zoom in for all' : ''}<span class="chev" aria-hidden="true">▾</span>`;
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
    html: `<span class="tchip"><b>${esc(t.code)}</b><i style="background:${c}">${esc(shortLate(t.delay, t.cancelled))}</i></span>`,
    iconSize: null, iconAnchor: [0, 14]
  });
  L.marker([t.lat, t.lon], { icon, keyboard: true, title: `${t.code} ${lateText(t.delay, t.cancelled)}` })
    .on('click', () => trainSheet(t)).addTo(trainLayer);
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
      <span class="what">${esc(where)}${t.toc ? `<small class="sub-line">${esc(t.toc)}</small>` : ''}</span><span class="mins c-${bd}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`;
  }).join('');
  openSheet(`<div class="st-head"><div><div class="meta">${lastRes.mode === 'live' ? 'Live' : 'Demo'} · most late first</div><h2 id="sheet-title">${lastRes.total || 0} trains in view</h2></div></div>
    <div class="sheet-body list flush">${rows || '<div class="empty">No trains in view. Zoom out or move the map.</div>'}
    ${more > 0 ? `<p class="note">Showing the ${items.length} most late. Zoom in to see the other ${more}.</p>` : ''}</div>`, {
    train: (id) => { const t = items.find((x) => x.id === id); if (t) trainSheet(t); }
  });
}
document.getElementById('map-count').addEventListener('click', listSheet);

function groupSheet(items) {
  const here = items[0].last;
  const rows = [...items].sort((a, b) => RANK[b.band] - RANK[a.band] || (b.delay ?? 0) - (a.delay ?? 0)).map((t) => {
    const bd = bandOf(t.delay, t.cancelled);
    return `<button class="row" data-act="train" data-arg="${esc(t.id)}"><span class="hc b-${bd}">${esc(t.code)}</span>
      <span class="what">${esc(t.dest ? 'to ' + t.dest : t.next ? 'next ' + t.next : 'at ' + t.last)}</span><span class="mins c-${bd}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`;
  }).join('');
  openSheet(`<div class="st-head"><div><div class="meta">${items.length} trains</div><h2 id="sheet-title">${esc(here ? 'At or near ' + here : 'Trains here')}</h2></div></div>
    <div class="sheet-body list flush">${rows}</div>`, {
    train: (id) => { const t = items.find((x) => x.id === id); if (t) trainSheet(t); }
  });
}

// ---------- the train screen: from, to, next stop, on time, every stop ----------
export async function trainSheet(t) {
  clearInterval(sheetTimer);
  let d = null;
  let detailed = false;
  const html = () => {
    const delay = d ? d.delay : t.delay, cancelled = d ? d.cancelled : t.cancelled;
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
      else if (s.state === 'passed') right = actual || '✓';
      else if (s.expected && s.expected !== s.booked && /\d/.test(s.expected)) right = `<span class="c-${bd}">${esc(s.expected)}</span>`;
      else if (s.expected === 'Delayed') right = '<span class="c-mid">Delayed</span>';
      else right = s.pass ? 'pass' : 'On time';
      const plat = s.platform ? `Plat ${esc(s.platform)}` : s.hiddenPlatform ? `Plat ${esc(s.hiddenPlatform)} <em>(not shown to public)</em>` : '';
      const booked = s.pass ? (s.working || s.booked || '') : (s.booked || '');
      return `<div class="stop ${cls}"><i></i><span class="sn">${esc(s.name)}${s.pass ? '<small>passes</small>' : plat ? `<small>${plat}</small>` : ''}</span><span class="sb">${esc(booked)}</span><span class="sa">${right}</span></div>`;
    }).join('')}</div>` : (d && d.note ? `<p class="note">${esc(d.note)}</p>` : '');
    const extras = d ? [
      d.length ? `${d.length} coaches` : null,
      d.cancelReason ? esc(d.cancelReason) : d.delayReason ? esc(d.delayReason) : null
    ].filter(Boolean) : [];
    const toggle = passCount ? `<button class="detail-toggle" data-act="detail" aria-pressed="${detailed}">${detailed ? 'Hide' : 'Show'} ${passCount} passing point${passCount === 1 ? '' : 's'}</button>` : '';
    const source = d && d.source === 'darwin' ? '<p class="credit">Stops ahead live from National Rail</p>' : d && d.liveNote ? `<p class="credit">${esc(d.liveNote)}</p>` : '';
    return `<div class="sheet-top"><div class="big b-${bd}">${esc(shortLate(delay, cancelled))}</div>
      <div><div class="meta">${esc(t.code)}${op ? ' · ' + esc(op) : ''}</div><h2 id="sheet-title">${title}</h2><p class="c-${bd === 'none' ? 'none' : bd}">${esc(lateText(delay, cancelled))}</p></div></div>
      ${next}
      ${last ? `<p class="lastseen">${esc(last.event || 'Seen')} ${esc(last.name)}${last.at ? ' at ' + hhmm(last.at) : ''}</p>` : ''}
      ${extras.length ? `<p class="lastseen">${extras.join(' · ')}</p>` : ''}
      <div class="sheet-body">${!d ? '<div class="empty">Loading stops…</div>' : stops + toggle + source}</div>
      ${d && d.stops && routeFromStops(d.stops) ? '<div class="sheet-actions one"><button data-act="route">Make this my route</button></div>' : ''}`;
  };
  const load = async () => {
    d = await api.train(t.id).catch(() => null);
    if (d && d.error) d = null;
    if (sheetOpen()) updateSheet(html());
  };
  openSheet(html(), {
    detail: () => { detailed = !detailed; updateSheet(html()); },
    route: () => {
      const origin = (d && d.origin) || t.origin, dest = (d && d.dest) || t.dest;
      const r = routeFromStops(d && d.stops, origin && dest ? `${origin} – ${dest}` : null);
      if (r) { closeCustomSheet(); window.dispatchEvent(new CustomEvent('mtt:route', { detail: { route: r, train: t.code } })); }
    }
  }, () => clearInterval(sheetTimer));
  load();
  sheetTimer = setInterval(load, 30000);
}

// ---------- stations ----------
function drawStations() {
  stationLayer.clearLayers();
  const z = map.getZoom();
  if (z < STATION_ZOOM) return;
  const b = map.getBounds();
  for (const [crs, name, lat, lon] of STATIONS) {
    if (!b.contains([lat, lon])) continue;
    const m = L.circleMarker([lat, lon], { radius: 6, color: '#E3B53A', weight: 2, fillColor: '#0C1B38', fillOpacity: 1 });
    if (z >= LABEL_ZOOM) m.bindTooltip(name, { permanent: true, direction: 'right', offset: [8, 0], className: 'stn-label' });
    m.on('click', () => stationSheet(crs));
    m.addTo(stationLayer);
  }
}

export async function stationSheet(crs, type = 'dep') {
  const st = BY_CRS.get(crs);
  if (!st) return;
  clearInterval(sheetTimer);
  let current = type;
  let data = null;
  const areas = loadList(AREAS_KEY);
  const saved = loadList(STATIONS_KEY);
  const html = () => `
    <div class="st-head"><div><div class="meta">${esc(crs)}</div><h2 id="sheet-title">${esc(st.name)}</h2></div></div>
    <div class="segctl" role="tablist">
      <button role="tab" data-act="type" data-arg="dep" aria-selected="${current === 'dep'}">Departures</button>
      <button role="tab" data-act="type" data-arg="arr" aria-selected="${current === 'arr'}">Arrivals</button>
    </div>
    <div class="sheet-body">${boardHTML(data, current)}</div>
    <div class="sheet-actions">
      <button data-act="watch">${areas.some((a) => a.crs === crs) ? 'Watching area' : 'Watch this area'}</button>
      <button data-act="save">${saved.some((s) => s.crs === crs) ? 'Saved' : 'Save station'}</button>
    </div>
    <div class="sheet-actions one"><button data-act="build">Build a route from here</button></div>`;
  async function load() {
    data = await api.board(crs, current).catch((e) => ({ error: e.message }));
    if (sheetOpen()) updateSheet(html());
  }
  openSheet(html(), {
    type: (t) => { current = t; data = null; updateSheet(html()); load(); },
    watch: () => { watchArea(st); updateSheet(html()); },
    build: () => { closeCustomSheet(); window.dispatchEvent(new CustomEvent('mtt:build', { detail: { crs } })); },
    save: () => {
      const list = loadList(STATIONS_KEY);
      if (!list.some((s) => s.crs === crs)) { list.unshift({ crs, name: st.name }); saveList(STATIONS_KEY, list.slice(0, 12)); toast(`${st.name} saved to Boards`); }
      updateSheet(html());
    }
  }, () => clearInterval(sheetTimer));
  load();
  sheetTimer = setInterval(load, 60000);
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
        return `<div class="mrow"><span class="btime">${hhmm(m.at)}</span><span class="hc b-${bd}">${esc(m.code)}</span>
          <span class="bplace"><b>${esc(m.event)} ${esc(m.name)}</b><small>${esc([m.dest ? 'to ' + m.dest : null, m.toc].filter(Boolean).join(' · '))}</small></span>
          <span class="mins c-${bd}">${esc(shortLate(m.delay))}</span></div>`;
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
