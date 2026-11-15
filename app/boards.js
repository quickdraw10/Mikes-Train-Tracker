// The Boards tab: departures and arrivals for any station. Search by name or
// code, use "Near me", or pick a saved station. Refreshes every minute.

import * as api from './api.js';
import { BY_CRS, nearest, searchStations } from './geo.js';
import { esc, loadList, saveList, toast, boardHTML, luBoardHTML } from './ui.js';
import { trainSheet, boardTrain, locationSheet } from './mapview.js';

const STATIONS_KEY = 'mtt.stations';
const $root = document.getElementById('boardsview');
let current = null;     // { crs, name }
let type = 'dep';
let bound = null; // Underground: which direction's tab is open
let data = null;
let timer;
let near = [];
// Find a train: "the 17:34 from Glasgow" (it may have left hours ago)
const fx = { crs: [], label: '', time: '', day: 0, results: null, busy: false };
const nowHHMM = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

export function showBoards() {
  if (!$root.dataset.ready) { $root.dataset.ready = '1'; wire(); }
  render();
  if (current) load();
}

function wire() {
  $root.addEventListener('input', (e) => {
    if (e.target.id === 'b-q') renderResults();
    if (e.target.id === 'f-q') { fx.crs = []; fx.label = ''; renderFindHits(); }
    if (e.target.id === 'f-time') fx.time = e.target.value;
    if (e.target.id === 'l-q') searchLoc(e.target.value);
  });
  $root.addEventListener('keydown', (e) => {
    if (e.target.id === 'b-q' && e.key === 'Enter') { const f = $root.querySelector('#b-results button'); if (f) f.click(); }
  });
  $root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-crs],[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'loc') { const ul = $root.querySelector('#l-results'); if (ul) ul.hidden = true; return locationSheet(el.dataset.arg); }
    if (act === 'f-pick') { fx.crs = el.dataset.arg.split(','); fx.label = el.dataset.label; fx.results = null; return render(); }
    if (act === 'f-go') return findTrain();
    if (act === 'f-day') { fx.day = +el.dataset.arg; fx.results = null; return render(); }
    if (act === 'f-train') { const f = fx.results && fx.results.trains[+el.dataset.arg]; if (f) trainSheet({ id: f.id, code: f.headcode, dest: f.dest, origin: f.origin, toc: f.operator, delay: f.delay, cancelled: f.cancelled }); return; }
    if (act === 'f-clear') { fx.crs = []; fx.label = ''; fx.results = null; return render(); }
    if (el.dataset.crs) return pick(el.dataset.crs);
    if (act === 'bound') { bound = el.dataset.arg; render(); }
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
  bound = null;
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

function renderFindHits() {
  const q = $root.querySelector('#f-q'), ul = $root.querySelector('#f-results');
  if (!q || !ul) return;
  const hits = searchStations(q.value).filter((h) => !BY_CRS.get(h.crs) || !BY_CRS.get(h.crs).country);
  const word = q.value.trim();
  const all = hits.length > 1 && word.length >= 3 ? hits.filter((h) => h.name.toLowerCase().startsWith(word.toLowerCase())) : [];
  ul.innerHTML = (all.length > 1 ? `<li><button data-act="f-pick" data-arg="${all.map((h) => h.crs).join(',')}" data-label="${esc(word.replace(/^./, (c) => c.toUpperCase()))} (any station)"><b>Any ${esc(word)} station</b><small>${all.length} stations</small></button></li>` : '') +
    hits.map((h) => `<li><button data-act="f-pick" data-arg="${h.crs}" data-label="${esc(h.name)}"><b>${esc(h.name)}</b><small>${h.crs}</small></button></li>`).join('');
  ul.hidden = !hits.length;
}

async function findTrain() {
  const t = ($root.querySelector('#f-time') || {}).value || fx.time;
  if (!fx.crs.length) return toast('Pick the station first.');
  if (!/^\d{1,2}:\d{2}$/.test(t || '')) return toast('Enter the time, like 17:34.');
  fx.time = t; fx.busy = true; render();
  fx.results = await api.findTrain(fx.crs, t, fx.day).catch((e) => ({ error: e.message }));
  fx.busy = false; render();
}

function findHTML() {
  const r = fx.results;
  const rows = !r ? '' : r.error ? `<div class="empty">${esc(r.error)}</div>` : !r.trains.length ? `<div class="empty">No passenger trains booked from there within 15 minutes of ${esc(r.time)} ${r.day < 0 ? 'yesterday' : r.day > 0 ? 'tomorrow' : 'today'}.</div>`
    : (r.exact ? '' : `<div class="note pad">No train at exactly ${esc(r.time)}; these are the nearest.</div>`) + r.trains.map((f, i) => {
      const bd = f.cancelled ? 'bad' : f.delay == null ? 'none' : f.delay >= 10 ? 'bad' : f.delay >= 2 ? 'mid' : 'ok';
      return `<button class="row grow" data-act="f-train" data-arg="${i}">
        <span class="gtime"><b>${esc(f.dep)}</b><small>${f.startsHere ? 'starts' : 'calls'}</small></span>
        <span class="what">to ${esc(f.dest)}<small class="sub-line">${f.startsHere ? (fx.crs.length > 1 ? `from ${esc(f.station)} · ` : '') : `${esc(f.originDep)} from ${esc(f.origin)} · `}${esc(f.operator || '')}</small><small class="sub-line"><span class="c-${bd === 'none' ? 'none' : bd}">${esc(f.status)}${f.delay > 0 && !f.cancelled ? ` · +${f.delay}` : ''}</span></small></span>
        <span class="gright"><span class="mins">›</span><small class="hc-small">${esc(f.headcode || '')}</small></span></button>`;
    }).join('');
  return `<section class="list find"><div class="list-h">Find a train</div>
    <div class="find-form">
      ${fx.crs.length ? `<button class="find-st" data-act="f-clear" aria-label="Change station"><span>From</span><b>${esc(fx.label)}</b><i>Change</i></button>`
        : `<div class="search-block"><label class="search" for="f-q"><span class="find-lbl">From</span><input id="f-q" type="search" placeholder="Station it leaves from" autocomplete="off"></label><ul id="f-results" class="results" hidden></ul></div>`}
      <div class="segctl find-day" role="tablist">${[[-1, 'Yesterday'], [0, 'Today'], [1, 'Tomorrow']].map(([d, n]) => `<button role="tab" data-act="f-day" data-arg="${d}" aria-selected="${fx.day === d}">${n}</button>`).join('')}</div>
      <label class="find-time"><span>Departing at</span><input id="f-time" type="time" value="${esc(fx.time || nowHHMM())}"></label>
      <button class="find-go" data-act="f-go"${fx.busy ? ' disabled' : ''}>${fx.busy ? 'Finding…' : 'Find'}</button>
    </div>
    ${rows}
  </section>`;
}

// Junctions, yards and other timing points: search by name or code, open its location board
let locTimer = null;
function searchLoc(q) {
  clearTimeout(locTimer);
  locTimer = setTimeout(async () => {
    const ul = $root.querySelector('#l-results');
    if (!ul) return;
    if (q.trim().length < 3) { ul.hidden = true; return; }
    const r = await api.locations(q).catch(() => ({ results: [] }));
    const tidy = (n) => (n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s(/-])(\w)/g, (m, a, c) => a + c.toUpperCase()) : n);
    ul.innerHTML = (r.results || []).map((h) => `<li><button data-act="loc" data-arg="${esc(h.tiploc)}"><b>${esc(tidy(h.name))}</b><small>${esc(h.crs || h.tiploc)}</small></button></li>`).join('') || '<li class="empty">No matching locations</li>';
    ul.hidden = false;
  }, 250);
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
    $root.classList.remove('lu');
    const saved = loadList(STATIONS_KEY);
    $root.innerHTML = `
      <header class="head"><h1>Station boards</h1><div class="sub">Departures and arrivals for any station, or find a train by when it left</div></header>
      <div class="search-block">
        <label class="search" for="b-q">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="b-q" type="search" placeholder="Station name or code" autocomplete="off" enterkeyhint="search">
        </label>
        <ul id="b-results" class="results" hidden></ul>
      </div>
      ${findHTML()}
      <section class="list"><div class="list-h">Junctions &amp; other locations</div>
        <div class="find-form"><div class="search-block"><label class="search" for="l-q"><input id="l-q" type="search" placeholder="Junction, yard or loop, e.g. Colton Jn" autocomplete="off"></label><ul id="l-results" class="results" hidden></ul></div></div>
      </section>
      <section class="list"><div class="list-h">Near you</div>
        ${near.length ? stationList(near, true) : `<button class="row" data-act="near"><span class="what">Find stations near me</span><span class="mins c-ok">Locate</span></button>`}
      </section>
      <section class="list"><div class="list-h">Saved</div>
        ${saved.length ? stationList(saved, false) : '<div class="empty">Save a station from its board to keep it here.</div>'}
      </section>`;
    return;
  }
  const saved = loadList(STATIONS_KEY).some((s) => s.crs === current.crs);
  // Underground stations: LU colours and one board (TfL gives one list of predicted trains)
  const lu = (BY_CRS.get(current.crs) || {}).country === 'tfl';
  if (lu) type = 'dep';
  const luv = lu ? luBoardHTML(data, bound) : null;
  if (luv && luv.bound) bound = luv.bound;
  $root.classList.toggle('lu', lu);
  $root.innerHTML = `
    <header class="head">
      <button class="back" data-act="back">‹ Stations</button>
      <h1>${esc(current.name)}</h1>
      <div class="sub"><span>${esc(current.crs)}</span>${data && data.mode ? `<span class="pill ${data.mode === 'live' ? 'live' : 'demo'}">${data.mode === 'live' ? 'Live' : 'Demo'}</span>` : ''}</div>
    </header>
    ${lu ? `<div class="pad">${luv.tabs}</div>` : `<div class="segctl pad" role="tablist">
      <button role="tab" data-act="type" data-arg="dep" aria-selected="${type === 'dep'}">Departures</button>
      <button role="tab" data-act="type" data-arg="arr" aria-selected="${type === 'arr'}">Arrivals</button>
    </div>`}
    <section class="board">${lu ? luv.body : boardHTML(data, type)}</section>
    <div class="sheet-actions pad"><button data-act="save">${saved ? 'Remove from saved' : 'Save station'}</button></div>`;
}
