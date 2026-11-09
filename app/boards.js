// The Boards tab: departures and arrivals for any station. Search by name or
// code, use "Near me", or pick a saved station. Refreshes every minute.

import * as api from './api.js';
import { BY_CRS, nearest, searchStations } from './geo.js';
import { esc, loadList, saveList, toast, boardHTML } from './ui.js';
import { trainSheet, boardTrain } from './mapview.js';

const STATIONS_KEY = 'mtt.stations';
const $root = document.getElementById('boardsview');
let current = null;     // { crs, name }
let type = 'dep';
let data = null;
let timer;
let near = [];

export function showBoards() {
  if (!$root.dataset.ready) { $root.dataset.ready = '1'; wire(); }
  render();
  if (current) load();
}

function wire() {
  $root.addEventListener('input', (e) => { if (e.target.id === 'b-q') renderResults(); });
  $root.addEventListener('keydown', (e) => {
    if (e.target.id === 'b-q' && e.key === 'Enter') { const f = $root.querySelector('#b-results button'); if (f) f.click(); }
  });
  $root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-crs],[data-act]');
    if (!el) return;
    if (el.dataset.crs) return pick(el.dataset.crs);
    const act = el.dataset.act;
    if (act === 'type') { type = el.dataset.arg; data = null; render(); load(); }
    if (act === 'back') { current = null; clearInterval(timer); render(); }
    if (act === 'near') findNear();
    if (act === 'svc') { const row = data && data.services && data.services.find((x) => x.id === el.dataset.arg); if (row) trainSheet(boardTrain(row, current.crs, type)); }
    if (act === 'save') {
      const list = loadList(STATIONS_KEY);
      if (list.some((s) => s.crs === current.crs)) saveList(STATIONS_KEY, list.filter((s) => s.crs !== current.crs));
      else { list.unshift(current); saveList(STATIONS_KEY, list.slice(0, 12)); toast(`${current.name} saved`); }
      render();
    }
  });
}

function pick(crs) {
  const st = BY_CRS.get(crs);
  if (!st) return;
  current = { crs, name: st.name };
  data = null;
  render();
  load();
}

async function load() {
  clearInterval(timer);
  const want = current && current.crs + type;
  const res = await api.board(current.crs, type).catch((e) => ({ error: e.message }));
  if (current && current.crs + type === want) { data = res; render(); }
  timer = setInterval(async () => {
    if (!current || document.getElementById('boardsview').hidden) return;
    data = await api.board(current.crs, type).catch((e) => ({ error: e.message }));
    render();
  }, 60000);
}

function findNear() {
  if (!navigator.geolocation) return toast('This browser cannot share your location.');
  navigator.geolocation.getCurrentPosition((p) => {
    near = nearest(p.coords.latitude, p.coords.longitude, 5);
    render();
  }, (err) => toast(err.code === 1 ? 'Location is turned off for this app. Allow it in Settings › Safari › Location.' : 'Could not find your location just now.'),
  { timeout: 10000, maximumAge: 60000 });
}

function stationList(list, withKm) {
  return list.map((s) => `<button class="row" data-crs="${esc(s.crs)}"><span class="hc code-pill">${esc(s.crs)}</span><span class="what">${esc(s.name)}</span>${withKm ? `<span class="mins c-none">${s.km.toFixed(1)} km</span>` : ''}</button>`).join('');
}

function renderResults() {
  const q = $root.querySelector('#b-q');
  const ul = $root.querySelector('#b-results');
  const hits = searchStations(q.value);
  ul.innerHTML = hits.map((h) => `<li><button data-crs="${h.crs}"><b>${esc(h.name)}</b><small>${h.crs}</small></button></li>`).join('');
  ul.hidden = !hits.length;
}

function render() {
  if (!current) {
    const saved = loadList(STATIONS_KEY);
    $root.innerHTML = `
      <header class="head"><h1>Station boards</h1><div class="sub">Departures and arrivals for any station</div></header>
      <div class="search-block">
        <label class="search" for="b-q">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="b-q" type="search" placeholder="Station name or code" autocomplete="off" enterkeyhint="search">
        </label>
        <ul id="b-results" class="results" hidden></ul>
      </div>
      <section class="list"><div class="list-h">Near you</div>
        ${near.length ? stationList(near, true) : `<button class="row" data-act="near"><span class="what">Find stations near me</span><span class="mins c-ok">Locate</span></button>`}
      </section>
      <section class="list"><div class="list-h">Saved</div>
        ${saved.length ? stationList(saved, false) : '<div class="empty">Save a station from its board to keep it here.</div>'}
      </section>`;
    return;
  }
  const saved = loadList(STATIONS_KEY).some((s) => s.crs === current.crs);
  $root.innerHTML = `
    <header class="head">
      <button class="back" data-act="back">‹ Stations</button>
      <h1>${esc(current.name)}</h1>
      <div class="sub"><span>${esc(current.crs)}</span>${data && data.mode ? `<span class="pill ${data.mode === 'live' ? 'live' : 'demo'}">${data.mode === 'live' ? 'Live' : 'Demo'}</span>` : ''}</div>
    </header>
    <div class="segctl pad" role="tablist">
      <button role="tab" data-act="type" data-arg="dep" aria-selected="${type === 'dep'}">Departures</button>
      <button role="tab" data-act="type" data-arg="arr" aria-selected="${type === 'arr'}">Arrivals</button>
    </div>
    <section class="board">${boardHTML(data, type)}</section>
    <div class="sheet-actions pad"><button data-act="save">${saved ? 'Remove from saved' : 'Save station'}</button></div>`;
}
