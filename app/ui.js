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

// theme 'lu' gives the sheet the London Underground colours
export function openSheet(html, acts = {}, close = null, theme = null) {
  actions = acts;
  onClose = close;
  $card.classList.toggle('lu', theme === 'lu');
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
export function boardHTML(b, type) {
  if (!b) return `<div class="empty">Loading…</div>`;
  if (b.error) return `<div class="empty">${esc(b.error)}</div>`;
  if (!b.services.length) return `<div class="empty">${b.predictions ? 'No trains predicted right now.' : `No ${type === 'arr' ? 'arrivals' : 'departures'} in the next couple of hours.`}</div>`;
  const rows = b.services.map((s) => {
    const bd = s.expected === 'Delayed' && !s.cancelled ? 'mid' : bandOf(s.delay, s.cancelled);
    const exp = s.cancelled ? 'Canc' : s.expected === 'On time' ? 'On time' : s.expected || '–';
    const info = [
      s.next && !s.cancelled ? `<small class="bnext">${esc(s.nextLabel || 'Next stop')}: ${esc(s.next)}</small>` : '',
      s.toc || s.passenger === false ? `<small>${opBadge(s.toc, s.tocCode)}${esc([s.passenger === false ? 'Not in passenger service' : null, s.toc].filter(Boolean).join(' · '))}</small>` : '',
      s.length || s.firstClass ? `<small>${esc([s.length ? s.length + ' coaches' : null, s.firstClass].filter(Boolean).join(' · '))}</small>` : '',
    ].join('');
    return `<button class="brow${s.passenger === false ? ' nonpass' : ''}" data-act="svc" data-arg="${esc(s.id)}" aria-label="${esc((s.headcode ? s.headcode + ' ' : '') + s.place)}, details">
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
