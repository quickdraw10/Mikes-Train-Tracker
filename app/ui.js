// Small shared pieces: escaping, time formats, the bottom sheet, saved lists
// and the station board markup used by both the map and the Boards tab.

import { band } from './model.js';
import { opCode, OPERATORS } from './operators.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
export const lateText = (d, cancelled) => cancelled ? 'Cancelled' : d == null ? 'No timing yet' : d >= 1 ? `${d} min late` : d <= -1 ? `${-d} min early` : 'On time';
export const shortLate = (d, cancelled) => cancelled ? 'Canc' : d == null ? '–' : d >= 1 ? `+${d}` : 'On time';
export const bandOf = (delay, cancelled) => band(cancelled ? { cancelled: true } : delay == null ? null : { delay });

// Operator badge: the official two-letter code in the app's own style (no logos)
export function opBadge(nameOrCode, code) {
  const c = opCode(code) || opCode(nameOrCode);
  if (!c) return '';
  return `<span class="op" title="${esc(OPERATORS[c] || nameOrCode || c)}">${c}</span>`;
}

// ---- bottom sheet ----
const $sheet = document.getElementById('sheet');
const $card = $sheet.querySelector('.sheet-card');
let actions = {};
let onClose = null;

// An Underground station's board, split by direction (Northbound / Southbound, Eastbound / Westbound …)
// so you can see how often trains run each way. Tabs come from TfL's own platform names.
export function luBoardHTML(b, bound) {
  if (!b || b.error || !b.bounds || !b.bounds.length) return { tabs: '<div class="lu-boardname">Trains by direction</div>', body: boardHTML(b, 'dep'), bound: null };
  const pick = b.bounds.includes(bound) ? bound : b.bounds[0];
  const n = b.bounds.length;
  const tabs = `<div class="segctl lu-dirs" role="tablist" style="grid-template-columns: repeat(${n === 4 ? 2 : Math.min(n, 3)}, minmax(0, 1fr))">${b.bounds.map((x) =>
    `<button role="tab" data-act="bound" data-arg="${esc(x)}" aria-selected="${x === pick}">${esc(x)}</button>`).join('')}</div>`;
  const list = b.services.filter((s) => s.bound === pick);
  const soon = list.filter((s) => typeof s.secs === 'number' && s.secs <= 1200).length;
  const lines = [...new Map(list.filter((s) => s.lineName).map((s) => [s.lineName, s.lineColor])).entries()];
  const head = `<p class="lu-freq"><b>${soon}</b> train${soon === 1 ? '' : 's'} ${esc(pick.toLowerCase().startsWith('platform') ? 'from ' + pick : pick.toLowerCase())} in the next 20 minutes</p>${lines.length ? `<div class="lu-lines-at">${lines.map(([n, c]) => linePill(n, c)).join('')}</div>` : ''}`;
  return { tabs, body: head + boardHTML({ ...b, services: list }, 'dep'), bound: pick };
}

// theme 'lu' gives the sheet the London Underground colours
export function openSheet(html, acts = {}, close = null, theme = null, accent = null) {
  actions = acts;
  onClose = close;
  $card.classList.toggle('lu', theme === 'lu');
  // a Tube line's own colour for the stripe across the top of the sheet
  if (accent) $card.style.setProperty('--lu-red', accent); else $card.style.removeProperty('--lu-red');
  $card.innerHTML = `<div class="grab"></div>${html}<button class="close">Close</button>`;
  $sheet.hidden = false;
  $sheet.dataset.kind = 'custom';
}
export function updateSheet(html) {
  if ($sheet.hidden || $sheet.dataset.kind !== 'custom') return;
  const keep = $card.querySelector('.sheet-body');
  const scroll = keep ? keep.scrollTop : 0;
  $card.innerHTML = `<div class="grab"></div>${html}<button class="close">Close</button>`;
  const body = $card.querySelector('.sheet-body');
  if (body) body.scrollTop = scroll;
}
export function sheetOpen() { return !$sheet.hidden && $sheet.dataset.kind === 'custom'; }
export function closeCustomSheet() {
  if ($sheet.dataset.kind !== 'custom') return;
  $sheet.hidden = true;
  $sheet.dataset.kind = '';
  $card.classList.remove('lu');
  $card.style.removeProperty('--lu-red');
  const f = onClose; onClose = null; actions = {};
  if (f) f();
}
$card.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el.dataset.arg, el);
});
$sheet.addEventListener('click', (e) => {
  if (e.target === $sheet || e.target.closest('.close')) closeCustomSheet();
});

// ---- saved lists (this phone only) ----
export function loadList(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
export function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode: not saved */ }
}

// ---- toast ----
let toastTimer;
export function toast(text) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---- station board ----
// Readable text on a line colour (dark text on Circle yellow, H&C pink, etc.)
export function textOn(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return '#FFFFFF';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#0A1240' : '#FFFFFF';
}
export const linePill = (name, color) => `<span class="lpill" style="background:${esc(color)};color:${textOn(color)}">${esc(name)}</span>`;

export function boardHTML(b, type) {
  if (!b) return `<div class="empty">Loading…</div>`;
  if (b.error) return `<div class="empty">${esc(b.error)}</div>`;
  if (!b.services.length) return `<div class="empty">${b.predictions ? 'No trains predicted right now.' : `No ${type === 'arr' ? 'arrivals' : 'departures'} in the next couple of hours.`}</div>`;
  const rows = b.services.map((s) => {
    const bd = s.expected === 'Delayed' && !s.cancelled ? 'mid' : bandOf(s.delay, s.cancelled);
    const exp = s.cancelled ? 'Canc' : s.expected === 'On time' ? 'On time' : s.expected || '–';
    const info = [
      s.next && !s.cancelled ? `<small class="bnext">${esc(s.nextLabel || 'Next stop')}: ${esc(s.next)}</small>` : '',
      s.lineColor ? `<small class="lline">${linePill(s.lineName || String(s.toc || '').split(' · ')[0], s.lineColor)}${s.platform ? ' Platform ' + esc(s.platform) : ''}</small>` :
      s.toc || s.passenger === false ? `<small>${opBadge(s.toc, s.tocCode)}${esc([s.passenger === false ? 'Not in passenger service' : null, s.toc].filter(Boolean).join(' · '))}</small>` : '',
      s.length || s.firstClass ? `<small>${esc([s.length ? s.length + ' coaches' : null, s.firstClass].filter(Boolean).join(' · '))}</small>` : '',
    ].join('');
    return `<button class="brow${s.passenger === false ? ' nonpass' : ''}${s.lineColor ? ' lrow' : ''}"${s.lineColor ? ` style="--lc:${esc(s.lineColor)}"` : ''} data-act="svc" data-arg="${esc(s.id)}" aria-label="${esc((s.headcode ? s.headcode + ' ' : '') + s.place)}, details">
      <span class="btime">${esc(s.booked)}</span>
      <span class="bexp c-${bd}">${esc(s.departed ? 'Dep ' + (s.expected === 'On time' ? s.booked : s.expected) : exp)}</span>
      <span class="bplace"><b>${s.headcode ? `<span class="hcode">${esc(s.headcode)}</span>` : ''}${esc(s.place)}</b>${info}</span>
      <span class="bplat${s.platform ? '' : ' none'}${s.platformHidden ? ' hidden-plat' : ''}" title="${s.platformHidden ? 'Not shown on public screens' : ''}">${esc(s.platform || '–')}</span>
      ${s.reason ? `<span class="breason-row">${esc(s.reason)}</span>` : ''}
    </button>`;
  }).join('');
  const msgs = (b.messages || []).map((m) => `<p class="bmsg">${esc(m)}</p>`).join('');
  const credit = b.mode === 'live' ? `<p class="credit">${esc(b.credit || 'Departure and arrival information: National Rail')}</p>` : '';
  return `${msgs}<div class="bhead"><span>Due</span><span>Exp</span><span>${type === 'arr' ? 'From' : 'To'}</span><span>Plat</span></div>${rows}${credit}`;
}

// ---- swipe a sheet down to close it (the grab handle at the top) ----
// Works for every sheet: pulling down from the handle or header, or from the list once
// it's scrolled to the top, slides the sheet away; a short pull springs back.
{
  let startY = 0, dy = 0, dragging = false, startT = 0, scroller = null;
  const reset = () => { $card.style.transition = ''; $card.style.transform = ''; $sheet.style.background = ''; };
  $card.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('input, .segctl, .results')) return;
    scroller = e.target.closest('.sheet-body');
    startY = e.touches[0].clientY; startT = Date.now(); dy = 0; dragging = false;
  }, { passive: true });
  $card.addEventListener('touchmove', (e) => {
    if (!startY) return;
    const d = e.touches[0].clientY - startY;
    if (!dragging) {
      // only a downward pull, and not while the list is scrolled down
      if (d < 8 || (scroller && scroller.scrollTop > 0)) { if (d < -8 || (scroller && scroller.scrollTop > 0)) startY = 0; return; }
      dragging = true;
      $card.style.transition = 'none';
    }
    dy = Math.max(0, d);
    e.preventDefault();
    $card.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const end = () => {
    if (!dragging) { startY = 0; return; }
    const fast = dy / Math.max(1, Date.now() - startT) > 0.6;
    dragging = false; startY = 0;
    if (dy > Math.min(140, $card.offsetHeight * 0.3) || (fast && dy > 40)) {
      $card.style.transition = 'transform 0.18s ease-in';
      $card.style.transform = `translateY(${$card.offsetHeight + 40}px)`;
      setTimeout(() => { const btn = $card.querySelector('.close'); reset(); if (btn) btn.click(); }, 170);
    } else {
      $card.style.transition = 'transform 0.2s ease-out';
      $card.style.transform = '';
      setTimeout(reset, 220);
    }
  };
  $card.addEventListener('touchend', end);
  $card.addEventListener('touchcancel', end);
}
