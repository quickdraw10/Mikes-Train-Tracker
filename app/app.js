// The app: design A (signal box panel), design C (route line) and the tabs.
// Gets live updates from the data service; if it can't reach one,
// it runs demo trains in the browser so there's always something to see.

import { API_BASE } from './config.js';
import { buildView, band } from './model.js';
import { createSim } from './sim.js';
import * as api from './api.js';
import { closeCustomSheet, openSheet as openCustom, toast } from './ui.js';
import { showMap, trainSheet, stationSheet } from './mapview.js';
import * as route from './route.js';
import { BY_CRS, searchStations } from './geo.js';
import { showBoards } from './boards.js';
import { showNetwork } from './network.js';

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $sheetCard = $sheet.querySelector('.sheet-card');

let savedPanel = 0;
try { savedPanel = Number(localStorage.getItem('mtt.panel')) || 0; } catch { /* default */ }
const ui = { tab: 'panel', panel: savedPanel, route: 0, selected: null, view: null, source: 'wait' };

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
// Design A, drawn like a signaller's IECC screen: black background, grey track,
// occupied track lit white, headcodes in boxes coloured by delay, tiny signal heads.
const SVGW = 400, COLW = 41, X0 = 56, ROWH = 32, TOP = 56;
const colX = (c) => X0 + c * COLW;

function panelChips() {
  return `<div class="pchips" role="tablist" aria-label="Choose a signal panel">${ui.view.panels.map((x, i) => `<button role="tab" class="pchip" data-panel="${i}" aria-selected="${i === ui.panel}">${esc(x.name)}</button>`).join('')}</div>`;
}

function renderPanel() {
  if (ui.panel >= ui.view.panels.length) ui.panel = 0;
  const p = ui.view.panels[ui.panel];
  if (!p) return '';
  const quiet = p.quietMins === null
    ? `<div class="sub"><span class="pill wait">Waiting for area ${esc(p.area)}</span></div>`
    : p.quietMins >= 5 ? `<div class="sub"><span class="pill wait c-bad">No signalling messages from ${esc(p.area)} for ${p.quietMins} min</span></div>` : '';
  const head = panelChips() + `<header class="head"><h1>${esc(p.name)}</h1><div class="sub">${esc(p.subtitle)}</div><div class="sub">${statusLine(ui.view)}</div>${quiet}</header>`;
  if (!p.tracks.length) {
    return head + `<div class="iecc-wrap"><div class="iecc-empty">${esc(p.note || 'Building the layout from Network Rail\'s berth data…')}</div></div>`;
  }

  const n = p.tracks.length;
  const H = TOP + n * ROWH + 44;
  const rowY = (i) => TOP + i * ROWH + ROWH / 2;
  const L = 6, R = SVGW - 6, lx = colX(0) - COLW / 2 - 4, rx = colX(7) + COLW / 2 + 4;
  let g = '';

  // throats: each road fans into the main lines at both ends
  const mains = 4;
  const mainY = (k) => TOP + (n * ROWH) * (k + 0.5) / mains;
  p.tracks.forEach((t, i) => {
    const k = Math.min(mains - 1, Math.floor(i * mains / n));
    const minCol = Math.min(...t.berths.map((b) => b.col)), maxCol = Math.max(...t.berths.map((b) => b.col));
    const start = colX(minCol) - COLW / 2, end = colX(maxCol) + COLW / 2;
    if (minCol === 0) g += `<path d="M${L + 12} ${mainY(k)} L${lx} ${rowY(i)}" class="tk"/>`;
    if (maxCol === 7) g += `<path d="M${rx} ${rowY(i)} L${R - 12} ${mainY(k)}" class="tk"/>`;
    g += `<line x1="${start}" y1="${rowY(i)}" x2="${end}" y2="${rowY(i)}" class="tk"/>`;
    if (minCol > 0) g += `<line x1="${start}" y1="${rowY(i) - 5}" x2="${start}" y2="${rowY(i) + 5}" class="tk"/>`;
    if (maxCol < 7) g += `<line x1="${end}" y1="${rowY(i) - 5}" x2="${end}" y2="${rowY(i) + 5}" class="tk"/>`;
  });
  for (let k = 0; k < mains; k++) {
    g += `<line x1="${L}" y1="${mainY(k)}" x2="${L + 12}" y2="${mainY(k)}" class="tk"/><line x1="${R - 12}" y1="${mainY(k)}" x2="${R}" y2="${mainY(k)}" class="tk"/>`;
  }

  // platforms
  p.tracks.forEach((t, i) => {
    const pc = t.berths.filter((b) => b.kind === 'platform').map((b) => b.col);
    if (!pc.length) return;
    const x1 = colX(Math.min(...pc)) - COLW / 2 + 2, x2 = colX(Math.max(...pc)) + COLW / 2 - 2;
    g += `<rect x="${x1}" y="${rowY(i) + 9}" width="${x2 - x1}" height="4" class="i-plat"/>`;
    g += `<text x="${(x1 + x2) / 2}" y="${rowY(i) + 13}" class="pnum" text-anchor="middle" dy="0.1em">${esc(t.name)}</text>`;
  });

  // berths: occupied track, signal heads, headcodes
  p.tracks.forEach((t, i) => {
    const y = rowY(i);
    for (const b of t.berths) {
      const cx = colX(b.col);
      if (b.code) g += `<line x1="${cx - COLW / 2 + 2}" y1="${y}" x2="${cx + COLW / 2 - 2}" y2="${y}" class="i-occglow"/><line x1="${cx - COLW / 2 + 2}" y1="${y}" x2="${cx + COLW / 2 - 2}" y2="${y}" class="i-occ"/>`;
      const sx = b.col <= 3 ? cx + COLW / 2 - 2 : cx - COLW / 2 + 2;
      const cls = b.signal === 'on' ? 'on' : b.signal === 'off' ? 'off' : 'unk';
      g += `<line x1="${sx}" y1="${y - 2}" x2="${sx}" y2="${y - 8}" class="stem"/><circle cx="${sx}" cy="${y - 10.5}" r="2.8" class="sg ${cls}"><title>Signal ${esc(p.area + b.id)}</title></circle>`;
      if (b.code) {
        g += `<g class="hcbox b-${b.band}" data-train="${esc(b.code)}" tabindex="0" role="button" aria-label="${esc(b.code)} at platform road ${esc(t.name)}, ${esc(lateText(b.delay))}">
          <rect x="${cx - 17}" y="${y - 7.5}" width="34" height="15" rx="1.5"/><text x="${cx}" y="${y + 3.6}" text-anchor="middle">${esc(b.code)}</text></g>`;
      } else {
        g += `<rect x="${cx - 17}" y="${y - 7.5}" width="34" height="15" rx="1.5" class="berth-empty"><title>Berth ${esc(b.id)}</title></rect>`;
      }
    }
  });

  // labels
  g += `<text x="${SVGW / 2}" y="20" class="lbl big" text-anchor="middle">${esc(p.name.toUpperCase())}</text>`;
  g += `<text x="${L + 4}" y="38" class="lbl">◀ ${esc(p.ends[0])}</text><text x="${R - 4}" y="38" class="lbl" text-anchor="end">${esc(p.ends[1])} ▶</text>`;
  g += `<text x="${L + 4}" y="${H - 14}" class="clock">${new Date(ui.view.updated).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })}</text>`;
  g += `<text x="${R - 4}" y="${H - 14}" class="lbl small" text-anchor="end">TD ${esc(p.area)}</text>`;

  const late = p.late.length
    ? p.late.map((t) => `<button class="row" data-train="${esc(t.code)}"><span class="hc b-${band(t)}">${esc(t.code)}</span><span class="what">${esc(t.desc || 'Platform road ' + t.track)}</span><span class="mins c-${band(t)}">${esc(shortLate(t.delay, t.cancelled))}</span></button>`).join('')
    : `<div class="empty">Nothing running late here right now.</div>`;

  return `${head}
    <div class="iecc-wrap"><svg class="iecc" viewBox="0 0 ${SVGW} ${H}" role="img" aria-label="Signal panel for ${esc(p.name)}">${g}</svg></div>
    <p class="note">Tap a headcode for that train. Pinch to zoom in.</p>
    ${legend()}
    <section class="list"><div class="list-h">Late on this panel</div>${late}</section>`;
}

function legend() {
  const extra = ui.tab === 'route'
    ? '<span><i class="b-none"></i>No recent trains</span>'
    : '<span><b class="sig on" style="position:static;transform:none"></b>Signal on</span><span><b class="sig off" style="position:static;transform:none"></b>Signal off</span>';
  return `<div class="legend"><span><i class="b-ok"></i>On time</span><span><i class="b-mid"></i>2–9 late</span><span><i class="b-bad"></i>10+ late</span>${extra}</div>`;
}

// ---------- C: route line (any route you choose) ----------
let routeData = null;
let routeTimer = null;
const ROUTE_POLL_MS = 20000;

async function loadRoute() {
  const r = route.currentRoute();
  const d = await route.refresh(r).catch(() => null);
  if (d && d.id === route.currentRoute().id) { routeData = d; if (ui.tab === 'route') render(); }
}
function startRoute() {
  if (routeTimer) return;
  loadRoute();
  routeTimer = setInterval(() => { if (ui.tab === 'route' && !document.hidden) loadRoute(); }, ROUTE_POLL_MS);
}
function useRoute(r) {
  const c = route.setRoute(r);
  if (!c) return;
  routeData = null;
  closeCustomSheet();
  switchTab('route');
  loadRoute();
}

function renderRoute() {
  const r = route.currentRoute();
  const d = routeData && routeData.id === r.id ? routeData : null;
  const first = esc(BY_CRS.get(r.crs[0]).name), last = esc(BY_CRS.get(r.crs[r.crs.length - 1]).name);
  const head = `<header class="head route-head"><div class="rh-top"><h1>${esc(r.name)}</h1><button class="change" data-act-route="pick">Change</button></div>
    <div class="sub">${r.crs.length} stations · ${route.routeKm(r)} km${d ? ' · ' + (d.mode === 'live' ? '<span class="pill live">Live</span>' : '<span class="pill demo">Demo</span>') + ' ' + hhmm(d.updated) : ''}</div></header>`;
  if (!d) return head + `<div class="empty">Finding trains on this route…</div>`;

  // Each section is tall enough for the trains in it, so busy stretches open up
  const n = r.crs.length;
  const counts = d.sections.down.map((s, i) => s.count + d.sections.up[i].count);
  const gaps = counts.map((c) => Math.max(70, 40 + c * 38));
  const ys = [12];
  for (let i = 0; i < n - 1; i++) ys.push(ys[i] + gaps[i]);
  const yAt = (pos) => { const i = Math.min(n - 2, Math.floor(pos)); return ys[i] + (pos - i) * gaps[i]; };
  const xD = 14, xU = 42;
  let html = '';
  for (const dir of ['down', 'up']) {
    d.sections[dir].forEach((s, i) => {
      html += `<div class="seg b-${s.band}" style="left:${dir === 'down' ? xD : xU}px;top:${ys[i] + 6}px;height:${gaps[i]}px"></div>`;
    });
  }
  d.stations.forEach((name, i) => {
    const y = ys[i];
    html += `<div class="stn" style="left:${xD - 4}px;top:${y}px"></div><div class="stn" style="left:${xU - 4}px;top:${y}px"></div>`;
    html += `<button class="sname" data-act-route="station" data-crs="${esc(d.crs[i])}" style="top:${y - 3}px">${esc(name)}</button>`;
  });
  const placed = d.trains.map((t) => ({ t, y: 7 + yAt(t.pos) })).sort((a, b) => a.y - b.y);
  let lastChip = -Infinity;
  for (const { t, y } of placed) {
    html += `<div class="tdot b-${t.band}" style="left:${(t.dir === 'down' ? xD : xU) - 6}px;top:${y - 9}px"></div>`;
    let cy = Math.max(y - 16, lastChip + 36);
    // keep chips off the station names
    for (const sy of ys) if (cy < sy + 18 && cy + 32 > sy - 8) cy = sy + 18;
    lastChip = cy;
    html += `<button class="chip" data-rtrain="${esc(t.id)}" style="top:${cy}px" aria-label="${esc(t.code)} towards ${t.dir === 'down' ? last : first}, ${esc(lateText(t.delay, t.cancelled))}">
      <span class="arrow">${t.dir === 'down' ? '↓' : '↑'}</span><span class="code">${esc(t.code)}</span><span class="late b-${t.band}">${esc(shortLate(t.delay, t.cancelled))}</span>${t.dest ? `<span class="cdest">${esc(t.dest)}</span>` : ''}</button>`;
  }
  const s = d.summary;
  const avgBand = s.avg == null ? 'none' : band({ delay: s.avg });
  const worst = s.worst && s.worst.delay >= 2 ? `Worst: ${esc(s.worst.code)} ${esc(shortLate(s.worst.delay))}${s.worst.last ? ' near ' + esc(s.worst.last) : ''}` : 'Nothing badly late';
  const height = Math.max(ys[n - 1] + 40, lastChip + 44);

  return `${head}
    <div class="summary">
      <div class="avg b-${avgBand}"><b>${s.avg == null ? '–' : '+' + s.avg}</b><small>MIN AVG</small></div>
      <div><div class="t1">${s.lateCount} of ${s.total} trains running late</div><div class="t2">${worst}</div></div>
    </div>
    <div class="cols"><span style="width:58px;white-space:nowrap">↓ &nbsp; ↑</span><span>Station</span></div>
    <div class="strip" style="height:${height}px">${html}</div>
    ${legend()}
    <p class="note">↓ towards ${last}, ↑ towards ${first}. Trains within a few km of the line are shown; a section keeps the colour of the last train through it for 20 minutes.</p>`;
}

// Choosing a route: main lines, your recent routes, or build one
function routePicker() {
  const cur = route.currentRoute();
  const row = (r, act) => `<button class="row" data-act="${act}" data-arg="${esc(r.id)}"><span class="what"><b>${esc(r.name)}</b><small class="sub-line">${r.crs.length} stations · ${route.routeKm(r)} km</small></span>${r.id === cur.id ? '<span class="tick">✓</span>' : ''}</button>`;
  const recent = route.recentRoutes();
  openCustom(`<div class="st-head"><div><div class="meta">Route tab</div><h2 id="sheet-title">Choose a route</h2></div></div>
    <div class="sheet-body list flush">
      <div class="list-h">Build your own</div>
      <button class="row" data-act="build"><span class="what"><b>Pick stations in order</b><small class="sub-line">Or open a train and tap "Make this my route"</small></span><span class="tick">＋</span></button>
      <button class="row" data-act="reverse"><span class="what"><b>Flip this route</b><small class="sub-line">${esc(route.nameFor([...cur.crs].reverse()))}</small></span><span class="tick">⇅</span></button>
      ${recent.length ? `<div class="list-h">Your recent routes</div>${recent.map((r) => row(r, 'recent')).join('')}` : ''}
      <div class="list-h">Main lines</div>${route.PRESETS.map((r) => row(r, 'preset')).join('')}
    </div>`, {
    preset: (id) => useRoute(route.PRESETS.find((r) => r.id === id)),
    recent: (id) => useRoute(recent.find((r) => r.id === id)),
    reverse: () => useRoute({ name: cur.name.includes(' – ') ? cur.name.split(' – ').reverse().join(' – ') : cur.name + ' (reversed)', crs: [...cur.crs].reverse() }),
    build: () => routeBuilder()
  });
}

function routeBuilder(startCrs) {
  const picked = startCrs ? [startCrs] : [];
  const listHTML = () => picked.length
    ? picked.map((c, i) => `<div class="rb-stop"><i></i><span>${esc(BY_CRS.get(c).name)}</span><button data-act="remove" data-arg="${i}" aria-label="Remove ${esc(BY_CRS.get(c).name)}">✕</button></div>`).join('')
    : '<div class="empty">Add the stations in the order the trains run.</div>';
  openCustom(`<div class="st-head"><div><div class="meta">Build a route</div><h2 id="sheet-title">Pick stations in order</h2></div></div>
    <div class="sheet-body">
      <div id="rb-list" class="rb-list"></div>
      <label class="search rb-search" for="rb-q"><input id="rb-q" type="search" placeholder="Add a station" autocomplete="off" enterkeyhint="done"></label>
      <ul id="rb-results" class="results inline" hidden></ul>
      <p class="note">Tip: add the main stations along the line. Trains between them are placed on the route automatically.</p>
    </div>
    <div class="sheet-actions one"><button data-act="use" id="rb-use">Use this route</button></div>`, {
    remove: (i) => { picked.splice(Number(i), 1); draw(); },
    add: (crs) => { if (picked[picked.length - 1] !== crs) picked.push(crs); q.value = ''; results.hidden = true; draw(); q.focus(); },
    use: () => { if (picked.length >= 2) useRoute({ crs: picked }); }
  });
  const q = document.getElementById('rb-q'), results = document.getElementById('rb-results');
  const draw = () => {
    document.getElementById('rb-list').innerHTML = listHTML();
    const use = document.getElementById('rb-use');
    use.disabled = picked.length < 2;
    use.textContent = picked.length < 2 ? `Add ${2 - picked.length} more station${picked.length === 1 ? '' : 's'}` : `Use this route (${picked.length} stations)`;
  };
  q.addEventListener('input', () => {
    const hits = searchStations(q.value, 6);
    results.innerHTML = hits.map((h) => `<li><button data-act="add" data-arg="${h.crs}"><b>${esc(h.name)}</b><small>${h.crs}</small></button></li>`).join('');
    results.hidden = !hits.length;
  });
  draw();
  if (!startCrs) setTimeout(() => q.focus(), 50);
}

window.addEventListener('mtt:route', (e) => { useRoute(e.detail.route); toast(e.detail.quiet ? `${e.detail.route.name} is now on the Route tab` : `Route set from ${e.detail.train}'s stops`); });
window.addEventListener('mtt:build', (e) => { switchTab('route'); routeBuilder(e.detail.crs); });

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
  document.getElementById('netview').hidden = ui.tab !== 'network';
  document.getElementById('infoview').hidden = ui.tab !== 'info';
  $view.hidden = ui.tab !== 'panel' && ui.tab !== 'route';
  if ($view.hidden) return;
  if (!ui.view) { $view.innerHTML = `<header class="head"><h1>Train Tracker</h1><div class="sub"><span class="pill wait">Connecting…</span></div></header>`; return; }
  $view.innerHTML = ui.tab === 'panel' ? renderPanel() : renderRoute();
  if (ui.selected) renderSheet();
}

function switchTab(tab) {
  if (tab !== 'info') ui.lastTab = tab;
  ui.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => { if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  window.scrollTo(0, 0);
  render();
  if (tab === 'map') showMap();
  if (tab === 'boards') showBoards();
  if (tab === 'route') startRoute();
  if (tab === 'network') showNetwork(document.getElementById('netview'), { train: trainSheet, station: (crs) => stationSheet(crs) });
}

document.getElementById('info-btn').addEventListener('click', () => switchTab('info'));
document.getElementById('info-back').addEventListener('click', () => switchTab(ui.lastTab || 'map'));

document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});
$view.addEventListener('click', (e) => {
  const pc = e.target.closest('[data-panel]');
  if (pc) { ui.panel = Number(pc.dataset.panel); try { localStorage.setItem('mtt.panel', String(ui.panel)); } catch { /* not saved */ } render(); return; }
  const rt = e.target.closest('[data-rtrain]');
  if (rt) { const t = routeData && routeData.trains.find((x) => x.id === rt.dataset.rtrain); if (t) trainSheet(t); return; }
  const ra = e.target.closest('[data-act-route]');
  if (ra) { if (ra.dataset.actRoute === 'pick') routePicker(); else stationSheet(ra.dataset.crs); return; }
  const el = e.target.closest('[data-train]');
  if (el) openSheet(el.dataset.train);
});
$sheet.addEventListener('click', (e) => { if (e.target === $sheet || e.target.closest('.close')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$sheet.hidden) { closeCustomSheet(); closeSheet(); } });

switchTab('map');
connect();
