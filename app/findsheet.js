// Find a train, opened from the map's search bar: "the 17:34 from Glasgow", or "Glasgow to London
// around 17:30". From a station (or any station matching a name), optionally to a destination, on
// yesterday, today or tomorrow, at a time. With a destination the time only needs to be roughly
// right: every train between the two within about an hour is listed.

import * as api from './api.js';
import { BY_CRS, searchStations } from './geo.js';
import { STATIONS } from './stations.js';
import { esc, openSheet, updateSheet, toast } from './ui.js';
import { trainSheet } from './mapview.js';

const fx = { from: null, to: null, day: 0, time: '', results: null, busy: false, picking: null, q: '' };
const nowHHMM = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const gbOnly = (h) => !BY_CRS.get(h.crs) || !BY_CRS.get(h.crs).country;

function pickerHTML() {
  const hits = searchStations(fx.q).filter(gbOnly);
  const word = fx.q.trim();
  // "Any London station": every station whose name starts with the word, not just the first few shown
  const all = word.length >= 3 ? STATIONS.filter(([c, n]) => n.toLowerCase().startsWith(word.toLowerCase()) && gbOnly({ crs: c })).map(([c, n]) => ({ crs: c, name: n })) : [];
  const rows = (all.length > 1 ? `<li><button data-act="pick" data-arg="${all.map((h) => h.crs).join(',')}" data-label="Any ${esc(word)} station"><b>Any ${esc(word)} station</b><small>${all.length} stations</small></button></li>` : '') +
    hits.map((h) => `<li><button data-act="pick" data-arg="${h.crs}" data-label="${esc(h.name)}"><b>${esc(h.name)}</b><small>${h.crs}</small></button></li>`).join('');
  return `<div class="search-block"><label class="search" for="fx-q"><span class="find-lbl">${fx.picking === 'from' ? 'From' : 'To'}</span><input id="fx-q" type="search" value="${esc(fx.q)}" placeholder="${fx.picking === 'from' ? 'Station it leaves from' : 'Station it goes to'}" autocomplete="off"></label>
    <ul class="results fx-list"${rows ? '' : ' hidden'}>${rows}</ul></div>`;
}

function resultsHTML() {
  const r = fx.results;
  if (!r) return '';
  if (r.error) return `<div class="empty">${esc(r.error)}</div>`;
  const when = r.day < 0 ? 'yesterday' : r.day > 0 ? 'tomorrow' : 'today';
  if (!r.trains.length) return `<div class="empty">No passenger trains ${fx.to ? `from ${esc(fx.from.label)} to ${esc(fx.to.label)}` : 'from there'} between 90 minutes before and 2 hours after ${esc(r.time)} ${when}.</div>`;
  const head = `<div class="note">${r.trains.length} train${r.trains.length === 1 ? '' : 's'} ${when}, from 90 minutes before ${esc(r.time)} to 2 hours after. The nearest to ${esc(r.time)} is highlighted.</div>`;
  return head + `<section class="list">${r.trains.map((f, i) => {
    const bd = f.cancelled ? 'bad' : f.delay == null ? 'none' : f.delay >= 10 ? 'bad' : f.delay >= 2 ? 'mid' : 'ok';
    const route = f.toName ? `to ${esc(f.toName)}${f.toArr ? ' · arr ' + esc(f.toArr) : ''}` : `to ${esc(f.dest)}`;
    const via = [f.startsHere ? (fx.from.crs.length > 1 ? 'from ' + esc(f.station) : '') : `${esc(f.originDep)} from ${esc(f.origin)}`, f.toName && f.toName !== f.dest ? 'continues to ' + esc(f.dest) : '', esc(f.operator || '')].filter(Boolean).join(' · ');
    return `<button class="row grow${f.nearest ? ' nearest' : ''}" data-act="train" data-arg="${i}">
      <span class="gtime"><b>${esc(f.dep)}</b><small>${f.startsHere ? 'starts' : 'calls'}</small></span>
      <span class="what">${route}<small class="sub-line">${via}</small><small class="sub-line"><span class="c-${bd}">${esc(f.status)}${f.delay > 0 && !f.cancelled ? ` · +${f.delay}` : ''}</span></small></span>
      <span class="gright"><span class="mins">›</span><small class="hc-small">${esc(f.headcode || '')}</small></span></button>`;
  }).join('')}</section>`;
}

function html() {
  const stationBtn = (which, v, ph) => `<button class="find-st" data-act="choose" data-arg="${which}"><span>${which === 'from' ? 'From' : 'To'}</span><b${v ? '' : ' class="ph"'}>${esc(v ? v.label : ph)}</b>${v && which === 'to' ? '<i data-act="clear-to">Remove</i>' : '<i>Change</i>'}</button>`;
  return `<div class="st-head"><div><div class="meta">Search</div><h2 id="sheet-title">Find a train</h2></div></div>
    <div class="sheet-body">
      <div class="find-form">
        ${fx.picking === 'from' ? pickerHTML() : stationBtn('from', fx.from, 'Choose a station')}
        ${fx.picking === 'to' ? pickerHTML() : stationBtn('to', fx.to, 'Any destination (optional)')}
        <div class="segctl find-day" role="tablist">${[[-1, 'Yesterday'], [0, 'Today'], [1, 'Tomorrow']].map(([d, n]) => `<button role="tab" data-act="day" data-arg="${d}" aria-selected="${fx.day === d}">${n}</button>`).join('')}</div>
        <label class="find-time"><span>${fx.to ? 'Around' : 'Departing at'}</span><input id="fx-time" type="time" value="${esc(fx.time || nowHHMM())}"></label>
        <button class="find-go" data-act="go"${fx.busy ? ' disabled' : ''}>${fx.busy ? 'Finding…' : 'Find'}</button>
      </div>
      <p class="note">${fx.to ? 'With a destination, the time only needs to be roughly right.' : 'Know where it goes? Add a destination and the time only needs to be roughly right.'}</p>
      ${resultsHTML()}
    </div>`;
}

const keepTime = () => { const t = document.getElementById('fx-time'); if (t && t.value) fx.time = t.value; };
const focusPicker = () => setTimeout(() => { const q = document.getElementById('fx-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 30);

async function go() {
  keepTime();
  if (!fx.from) return toast('Choose the station it leaves from.');
  if (!/^\d{1,2}:\d{2}$/.test(fx.time || nowHHMM())) return toast('Enter the time, like 17:34.');
  fx.busy = true; updateSheet(html());
  fx.results = await api.findTrain(fx.from.crs, fx.time || nowHHMM(), fx.day, fx.to ? fx.to.crs : []).catch((e) => ({ error: e.message }));
  fx.busy = false; updateSheet(html());
  // bring the train nearest the time asked for into view
  setTimeout(() => { const n = document.querySelector('.row.nearest'); if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
}

export function findTrainSheet(prefill = null) {
  if (prefill) { fx.from = prefill; fx.results = null; }
  if (!fx.from) { fx.picking = 'from'; fx.q = ''; }
  openSheet(html(), {
    choose: (which) => { keepTime(); fx.picking = which; fx.q = ''; updateSheet(html()); focusPicker(); },
    'clear-to': () => { keepTime(); fx.to = null; fx.results = null; updateSheet(html()); },
    pick: (arg, el) => { keepTime(); const v = { crs: arg.split(','), label: (el && el.dataset.label) || arg }; fx[fx.picking] = v; fx.picking = null; fx.q = ''; fx.results = null; updateSheet(html()); },
    day: (d) => { keepTime(); fx.day = +d; fx.results = null; updateSheet(html()); },
    go,
    train: (i) => { const f = fx.results && fx.results.trains[+i]; if (f) trainSheet({ id: f.id, code: f.headcode, dest: f.dest, origin: f.origin, toc: f.operator, delay: f.delay, cancelled: f.cancelled, back: () => findTrainSheet() }); }
  });
  if (fx.picking) focusPicker();
}

// typing in the station picker: redraw just the list so the keyboard stays up
document.addEventListener('input', (e) => {
  if (e.target.id !== 'fx-q') return;
  fx.q = e.target.value;
  const ul = document.querySelector('.fx-list');
  if (!ul) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = pickerHTML();
  const fresh = tmp.querySelector('.fx-list');
  ul.innerHTML = fresh.innerHTML;
  ul.hidden = fresh.hidden;
});
