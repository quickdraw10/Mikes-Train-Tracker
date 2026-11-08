// The app: design A (signal box panel) and design C (route line).
// Gets live updates from the data service; if it can't reach one,
// it runs demo trains in the browser so there's always something to see.

import { API_BASE } from './config.js';
import { buildView, band } from './model.js';
import { createSim } from './sim.js';
import * as api from './api.js';
import { closeCustomSheet } from './ui.js';
import { showMap } from './mapview.js';
import { showBoards } from './boards.js';

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $sheetCard = $sheet.querySelector('.sheet-card');

const ui = { tab: 'panel', panel: 0, route: 0, selected: null, view: null, source: 'wait' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const lateText = (d, cancelled) => cancelled ? 'Cancelled' : d == null ? 'No timing yet' : d >= 1 ? `${d} min late` : d <= -1 ? `${-d} min early` : 'On time';
const shortLate = (d, cancelled) => cancelled ? 'Canc' : d == null ? '–' : d >= 1 ? `+${d}` : 'On time';

// ---------- data ----------
function startDemo() {
  if (ui.source === 'demo') return;
  ui.source = 'demo';
  api.useDemo();
  const sim = createSim();
  const update = () => { ui.view = buildView(sim.raw); render(); };
  update();
  setInterval(() => { sim.tick(); update(); }, 4000);
}

function connect() {
  if (API_BASE === null || typeof EventSource === 'undefined') return startDemo();
  let got = false;
  const es = new EventSource(API_BASE + '/api/stream');
  const giveUp = setTimeout(() => { if (!got) { es.close(); startDemo(); } }, 4000);
  es.onmessage = (e) => {
    got = true;
    clearTimeout(giveUp);
    if (ui.source !== 'server') api.useServer(API_BASE);
    ui.source = 'server';
    ui.view = JSON.parse(e.data);
    render();
  };
  es.onerror = () => { if (!got) { clearTimeout(giveUp); es.close(); startDemo(); } };
}

// ---------- shared bits ----------
function statusLine(v) {
  const live = v.mode === 'live';
  return `<span class="pill ${live ? 'live' : 'demo'}">${live ? 'Live' : 'Demo trains'}</span><span>${live ? 'from signalling' : 'invented for testing'} · ${clock(v.updated)}</span>`;
}

function findTrain(code) {
  const v = ui.view;
  for (const r of v.routes) { const t = r.trains.find((x) => x.code === code); if (t) return t; }
  for (const p of v.panels) for (const tr of p.tracks) { const b = tr.berths.find((x) => x.code === code); if (b) return { code, delay: b.delay, band: b.band, desc: null, last: null, track: tr.name, area: p.name }; }
  return null;
}

// ---------- A: signal box panel ----------
function renderPanel() {
  const p = ui.view.panels[ui.panel];
  const pairs = Math.ceil(p.tracks.length / 2);
  const ys = p.tracks.map((_, i) => 80 + Math.floor(i / 2) * 150 + (i % 2) * 74);
  const height = 80 + (pairs - 1) * 150 + 74 + 80;
  const n = Math.max(...p.tracks.map((t) => t.berths.length));
  const x = (f) => `calc(40px + (100% - 66px) * ${f})`;

  let html = '';
  for (const [l, t] of [['8px', '8px'], ['auto', '8px'], ['8px', 'auto'], ['auto', 'auto']]) {
    html += `<span class="screw" style="left:${l === 'auto' ? 'auto' : l};right:${l === 'auto' ? '8px' : 'auto'};top:${t === 'auto' ? 'auto' : t};bottom:${t === 'auto' ? '8px' : 'auto'}"></span>`;
  }
  html += `<div class="ends"><span>◀ ${esc(p.ends[0])}</span><span>${esc(p.ends[1])} ▶</span></div>`;
  for (const pl of p.platforms || []) {
    const [a, b] = pl.between;
    html += `<div class="plat" style="left:${x(pl.from / n)};width:calc((100% - 66px) * ${(pl.to - pl.from) / n});top:${ys[a] + 23}px;height:${ys[b] - ys[a] - 46}px">${esc(pl.label)}</div>`;
  }
  p.tracks.forEach((t, i) => {
    const y = ys[i];
    html += `<div class="track" style="top:${y}px"></div><div class="tname" style="top:${y - 7}px">${esc(t.name)}</div>`;
    t.berths.forEach((b, j) => {
      const f = (j + 0.5) / n;
      const top = t.dir === 'down' ? y - 30 : y + 9;
      // Signal at the far end of the berth, on the other side of the track from the headcode box
      const sf = t.dir === 'down' ? (j + 1) / n : j / n;
      const sigTop = t.dir === 'down' ? y + 9 : y - 19;
      const sigCls = b.signal === 'on' ? 'on' : b.signal === 'off' ? 'off' : 'unk';
      const sigText = b.signal === 'on' ? 'on (red)' : b.signal === 'off' ? 'off (clear)' : 'state not known yet';
      if (j < t.berths.length - 1 || b.signal) {
        html += `<span class="post" style="left:${x(sf)};top:${t.dir === 'down' ? y + 3 : y - 9}px"></span>`;
        html += `<span class="sig ${sigCls}" style="left:${x(sf)};top:${sigTop}px" role="img" aria-label="Signal ${esc(p.area + b.id)} ${sigText}" title="Signal ${esc(p.area + b.id)}"></span>`;
      }
      if (b.code) {
        html += `<div class="occ glow b-${b.band}" style="left:${x(f)};top:${y - 1}px;width:calc((100% - 66px) / ${n} * 0.85)"></div>`;
        html += `<button class="berth has b-${b.band}" data-train="${esc(b.code)}" style="left:${x(f)};top:${top}px" aria-label="${esc(b.code)} on ${esc(t.name)}, ${esc(lateText(b.delay))}">${esc(b.code)}</button>`;
      } else {
        html += `<span class="berth" style="left:${x(f)};top:${top}px" title="Berth ${esc(b.id)}"></span>`;
      }
    });
  });
  html += `<div class="panel-foot">TD AREA ${esc(p.area)} · BERTHS STEP AS SIGNALS CLEAR</div>`;

  const late = p.late.length
    ? p.late.map((t) => `<button class="row" data-train="${esc(t.code)}"><span class="hc b-${band(t)}">${esc(t.code)}</span><span class="what">${esc(t.desc || 'On ' + t.track)}</span><span class="mins c-${band(t)}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`).join('')
    : `<div class="empty">Nothing running late here right now.</div>`;

  const quiet = p.quietMins === null
    ? `<div class="sub"><span class="pill wait">Waiting for area ${esc(p.area)}</span></div>`
    : p.quietMins >= 5 ? `<div class="sub"><span class="pill wait c-bad">No signalling messages from ${esc(p.area)} for ${p.quietMins} min</span></div>` : '';

  return `
    <header class="head"><h1>${esc(p.name)}</h1><div class="sub">${esc(p.subtitle)}</div><div class="sub">${statusLine(ui.view)}</div>${quiet}</header>
    <div class="panel" style="height:${height}px" role="img" aria-label="Signal box panel for ${esc(p.name)}">${html}</div>
    ${legend()}
    <section class="list"><div class="list-h">Late on this panel</div>${late}</section>`;
}

function legend() {
  const extra = ui.tab === 'route'
    ? '<span><i class="b-none"></i>No recent trains</span>'
    : '<span><b class="sig on" style="position:static;transform:none"></b>Signal on</span><span><b class="sig off" style="position:static;transform:none"></b>Signal off</span>';
  return `<div class="legend"><span><i class="b-ok"></i>On time</span><span><i class="b-mid"></i>2–9 late</span><span><i class="b-bad"></i>10+ late</span>${extra}</div>`;
}

// ---------- C: route line ----------
function renderRoute() {
  const r = ui.view.routes[ui.route];
  const gap = 84, top = 12, xD = 14, xU = 42;
  const n = r.stations.length;
  let html = '';
  for (const dir of ['down', 'up']) {
    r.sections[dir].forEach((s, i) => {
      html += `<div class="seg b-${s.band}" style="left:${dir === 'down' ? xD : xU}px;top:${top + i * gap + 6}px;height:${gap}px"></div>`;
    });
  }
  r.stations.forEach((name, i) => {
    const y = top + i * gap;
    html += `<div class="stn" style="left:${xD - 4}px;top:${y}px"></div><div class="stn" style="left:${xU - 4}px;top:${y}px"></div>`;
    html += `<div class="sname" style="top:${y - 3}px">${esc(name)}</div>`;
  });
  const placed = r.trains.map((t) => ({ t, y: top + 7 + t.pos * gap })).sort((a, b) => a.y - b.y);
  let lastChip = -Infinity;
  for (const { t, y } of placed) {
    html += `<div class="tdot b-${t.band}" style="left:${(t.dir === 'down' ? xD : xU) - 6}px;top:${y - 9}px"></div>`;
    // trains sit on the station rows' right-hand side; push down if two would overlap
    const cy = Math.max(y - 16, lastChip + 36);
    lastChip = cy;
    html += `<button class="chip" data-train="${esc(t.code)}" style="top:${cy}px" aria-label="${esc(t.code)} ${t.dir === 'down' ? 'away from London' : 'towards London'}, ${esc(lateText(t.delay, t.cancelled))}">
      <span class="arrow">${t.dir === 'down' ? '↓' : '↑'}</span><span class="code">${esc(t.code)}</span><span class="late b-${t.band}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`;
  }
  const s = r.summary;
  const avgBand = s.avg == null ? 'none' : band({ delay: s.avg });
  const worst = s.worst && s.worst.delay >= 2 ? `Worst: ${esc(s.worst.code)} ${esc(shortLate(s.worst.delay))}${s.worst.last ? ' near ' + esc(s.worst.last.name) : ''}` : 'Nothing badly late';
  const height = top + (n - 1) * gap + 40;

  return `
    <header class="head"><h1>${esc(r.name)}</h1><div class="sub">${statusLine(ui.view)}</div></header>
    <div class="summary">
      <div class="avg b-${avgBand}"><b>${s.avg == null ? '–' : '+' + s.avg}</b><small>MIN AVG</small></div>
      <div><div class="t1">${s.lateCount} of ${s.total} trains running late</div><div class="t2">${worst}</div></div>
    </div>
    <div class="cols"><span style="width:58px;white-space:nowrap">Down Up</span><span>Station</span></div>
    <div class="strip" style="height:${height}px">${html}</div>
    ${legend()}
    <p class="note">Down = away from London. A section keeps the colour of the last train through it for 20 minutes.</p>`;
}

// ---------- train sheet ----------
function openSheet(code) {
  ui.selected = code;
  $sheet.dataset.kind = '';
  renderSheet();
  $sheet.hidden = false;
  $sheetCard.querySelector('.close')?.focus();
}
function closeSheet() { ui.selected = null; $sheet.hidden = true; }
function renderSheet() {
  if (!ui.selected) return;
  const t = findTrain(ui.selected);
  const b = t ? t.band : 'none';
  const last = t && t.last ? `${esc(t.last.event)} ${esc(t.last.name)} at ${hhmm(t.last.at)}` : t && t.track ? `In the ${esc(t.area)} panel on ${esc(t.track)}` : 'Not seen recently';
  $sheetCard.innerHTML = `
    <div class="grab"></div>
    <div class="sheet-top">
      <div class="big b-${b}">${t ? esc(shortLate(t.delay, t.cancelled)) : '–'}</div>
      <div><div class="meta">${esc(ui.selected)}</div><h2 id="sheet-title">${esc((t && t.desc) || 'Train ' + ui.selected)}</h2><p>${t ? esc(lateText(t.delay, t.cancelled)) : ''}</p></div>
    </div>
    <p>${last}</p>
    <button class="close">Close</button>`;
}

// ---------- render & events ----------
function render() {
  const light = ui.tab === 'route';
  document.body.dataset.theme = light ? 'light' : 'dark';
  document.body.dataset.tab = ui.tab;
  document.querySelector('meta[name="theme-color"]').content = light ? '#FFFFFF' : '#0B0D12';
  document.getElementById('mapview').hidden = ui.tab !== 'map';
  document.getElementById('boardsview').hidden = ui.tab !== 'boards';
  $view.hidden = ui.tab !== 'panel' && ui.tab !== 'route';
  if ($view.hidden) return;
  if (!ui.view) { $view.innerHTML = `<header class="head"><h1>Train Tracker</h1><div class="sub"><span class="pill wait">Connecting…</span></div></header>`; return; }
  $view.innerHTML = ui.tab === 'panel' ? renderPanel() : renderRoute();
  if (ui.selected) renderSheet();
}

function switchTab(tab) {
  ui.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => { if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  window.scrollTo(0, 0);
  render();
  if (tab === 'map') showMap();
  if (tab === 'boards') showBoards();
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});
$view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-train]');
  if (el) openSheet(el.dataset.train);
});
$sheet.addEventListener('click', (e) => { if (e.target === $sheet || e.target.closest('.close')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$sheet.hidden) { closeCustomSheet(); closeSheet(); } });

switchTab('map');
connect();
