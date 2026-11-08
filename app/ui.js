// Small shared pieces: escaping, time formats, the bottom sheet, saved lists
// and the station board markup used by both the map and the Boards tab.

import { band } from './model.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
export const lateText = (d, cancelled) => cancelled ? 'Cancelled' : d == null ? 'No timing yet' : d >= 1 ? `${d} min late` : d <= -1 ? `${-d} min early` : 'On time';
export const shortLate = (d, cancelled) => cancelled ? 'Canc' : d == null ? '–' : d >= 1 ? `+${d}` : 'On time';
export const bandOf = (delay, cancelled) => band(cancelled ? { cancelled: true } : delay == null ? null : { delay });

// ---- bottom sheet ----
const $sheet = document.getElementById('sheet');
const $card = $sheet.querySelector('.sheet-card');
let actions = {};
let onClose = null;

export function openSheet(html, acts = {}, close = null) {
  actions = acts;
  onClose = close;
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
  if (!b.services.length) return `<div class="empty">No ${type === 'arr' ? 'arrivals' : 'departures'} in the next couple of hours.</div>`;
  const rows = b.services.map((s) => {
    const bd = bandOf(s.delay, s.cancelled);
    const exp = s.cancelled ? 'Canc' : s.expected === 'On time' ? 'On time' : s.expected || '–';
    return `<div class="brow">
      <span class="btime">${esc(s.booked)}</span>
      <span class="bexp c-${bd}">${esc(exp)}</span>
      <span class="bplace"><b>${esc(s.place)}</b><small>${esc([s.toc, s.reason].filter(Boolean).join(' · '))}</small></span>
      <span class="bplat${s.platform ? '' : ' none'}">${esc(s.platform || '–')}</span>
    </div>`;
  }).join('');
  const msgs = (b.messages || []).map((m) => `<p class="bmsg">${esc(m)}</p>`).join('');
  return `${msgs}<div class="bhead"><span>Due</span><span>Exp</span><span>${type === 'arr' ? 'From' : 'To'}</span><span>Plat</span></div>${rows}`;
}
