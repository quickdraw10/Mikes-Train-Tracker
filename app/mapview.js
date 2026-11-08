// The Map tab: a real zoomable map of every train, a station search, a
// "where am I" arrow, station boards, and areas to keep an eye on.
// Zoomed out you see every train as a dot coloured by delay; zoom in and
// they become headcode chips, and stations appear.

import * as api from './api.js';
import { STATIONS } from './stations.js';
import { BY_CRS, nearest, searchStations } from './geo.js';
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

function drawTrains(res) {
  trainLayer.clearLayers();
  const z = map.getZoom();
  const list = res.trains || [];
  for (const t of list) {
    const c = COLORS[t.band] || COLORS.none;
    let m;
    if (z >= CHIP_ZOOM) {
      const icon = L.divIcon({
        className: 'tchip-wrap',
        html: `<span class="tchip"><b>${esc(t.code)}</b><i style="background:${c}">${esc(shortLate(t.delay, t.cancelled))}</i></span>`,
        iconSize: null, iconAnchor: [0, 14]
      });
      m = L.marker([t.lat, t.lon], { icon, keyboard: true, title: `${t.code} ${lateText(t.delay, t.cancelled)}` });
    } else {
      m = L.circleMarker([t.lat, t.lon], { radius: z <= 7 ? 3 : 5, color: '#0C1B38', weight: 1, fillColor: c, fillOpacity: 0.95 });
    }
    m.on('click', () => trainSheet(t));
    m.addTo(trainLayer);
  }
  const count = document.getElementById('map-count');
  const shown = list.length < (res.total || 0) ? `${list.length} of ${res.total}` : `${list.length}`;
  const late = list.filter((t) => t.band === 'mid' || t.band === 'bad').length;
  count.innerHTML = `<span class="pill ${res.mode === 'live' ? 'live' : 'demo'}">${res.mode === 'live' ? 'Live' : 'Demo'}</span> ${shown} train${res.total === 1 ? '' : 's'} in view · <span class="c-mid">${late} late</span>${list.length < (res.total || 0) ? ' · zoom in for all' : ''}`;
}

function trainSheet(t) {
  const bd = bandOf(t.delay, t.cancelled);
  const where = t.next ? `${esc(t.lastEvent || 'Departed')} ${esc(t.last)}${t.lastAt ? ' at ' + hhmm(t.lastAt) : ''} · next ${esc(t.next)}` : `${esc(t.lastEvent || 'At')} ${esc(t.last)}${t.lastAt ? ' at ' + hhmm(t.lastAt) : ''}`;
  const route = t.origin && t.dest ? `${esc(t.origin)} → ${esc(t.dest)}` : 'Train ' + esc(t.code);
  openSheet(`<div class="sheet-top"><div class="big b-${bd}">${esc(shortLate(t.delay, t.cancelled))}</div>
    <div><div class="meta">${esc(t.code)}${t.toc ? ' · ' + esc(t.toc) : ''}</div><h2 id="sheet-title">${route}</h2><p>${esc(lateText(t.delay, t.cancelled))}</p></div></div>
    <p>${where}</p>`);
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
    </div>`;
  async function load() {
    data = await api.board(crs, current).catch((e) => ({ error: e.message }));
    if (sheetOpen()) updateSheet(html());
  }
  openSheet(html(), {
    type: (t) => { current = t; data = null; updateSheet(html()); load(); },
    watch: () => { watchArea(st); updateSheet(html()); },
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
