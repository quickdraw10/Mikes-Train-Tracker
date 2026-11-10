// Pinch to zoom, drag to move, and + / − / reset buttons for the Network tab's maps.
// Works on whatever <svg> is inside `wrap`, even after the map is redrawn (call apply()).
// At normal size, a one-finger drag is handed to the page (sideways = next page, up/down = scroll),
// so swiping between Network pages still works over the map.
//
// Lines keep their thickness and labels their size as you zoom (see .zoomable in style.css),
// and more station names appear as you zoom in (wrap gets classes z2, z3, z4).

const MAX = 8;

export function zoomable(wrap, { pager = null, page = null, onSettle = null } = {}) {
  const v = { s: 1, x: 0, y: 0 };
  let W = 0, H = 0;
  const svg = () => wrap.querySelector('svg');

  function base() {
    const el = svg();
    if (!el) return false;
    if (!el.dataset.vb0) el.dataset.vb0 = el.getAttribute('viewBox');
    [, , W, H] = el.dataset.vb0.split(/\s+/).map(Number);
    return true;
  }
  function clamp() {
    v.s = Math.min(MAX, Math.max(1, v.s));
    const vw = W / v.s, vh = H / v.s;
    v.x = Math.min(W - vw, Math.max(0, v.x));
    v.y = Math.min(H - vh, Math.max(0, v.y));
  }
  function apply() {
    if (!base()) return;
    clamp();
    const el = svg();
    el.setAttribute('viewBox', `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${(W / v.s).toFixed(2)} ${(H / v.s).toFixed(2)}`);
    el.style.setProperty('--zs', v.s.toFixed(3));
    // map units per screen pixel, so dots and names stay the same size on screen at any zoom
    const w = el.getBoundingClientRect().width;
    if (w > 0) el.style.setProperty('--upx', ((W / v.s) / w).toFixed(4));
    wrap.classList.toggle('zoomed', v.s > 1.01);
    for (const n of [2, 3, 4]) wrap.classList.toggle('z' + n, v.s >= n);
  }
  // zoom by factor f around a point on screen (client px)
  function zoomAt(f, cx, cy) {
    if (!base()) return;
    const r = svg().getBoundingClientRect();
    const px = (cx - r.left) / r.width, py = (cy - r.top) / r.height;
    const ux = v.x + px * (W / v.s), uy = v.y + py * (H / v.s);
    v.s = Math.min(MAX, Math.max(1, v.s * f));
    v.x = ux - px * (W / v.s); v.y = uy - py * (H / v.s);
    apply();
  }
  function centre() { const r = svg().getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  // show a given box (in the map's own units)
  function show(x, y, w, h) {
    if (!base()) return;
    v.s = Math.min(MAX, Math.max(1, Math.min(W / w, H / h)));
    v.x = x + w / 2 - W / v.s / 2; v.y = y + h / 2 - H / v.s / 2;
    apply();
  }

  // ---- gestures ----
  const pts = new Map();
  let start = null, moved = 0, mode = null, swallowClick = false;
  wrap.style.touchAction = 'none';
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zbtns')) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    wrap.setPointerCapture(e.pointerId);
    moved = 0; mode = null;
    start = { list: [...pts.values()].map((p) => [...p]), s: v.s, x: v.x, y: v.y, scrollL: pager ? pager.scrollLeft : 0, scrollT: page ? page.scrollTop : 0 };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const now = [...pts.values()];
    if (now.length >= 2 && start.list.length >= 2) {
      // pinch
      mode = 'pinch';
      const d0 = Math.hypot(start.list[0][0] - start.list[1][0], start.list[0][1] - start.list[1][1]) || 1;
      const d1 = Math.hypot(now[0][0] - now[1][0], now[0][1] - now[1][1]);
      const mx = (now[0][0] + now[1][0]) / 2, my = (now[0][1] + now[1][1]) / 2;
      v.s = start.s; v.x = start.x; v.y = start.y;
      zoomAt(d1 / d0, mx, my);
      moved = 99;
      return;
    }
    if (now.length !== 1 || start.list.length !== 1) return;
    const dx = now[0][0] - start.list[0][0], dy = now[0][1] - start.list[0][1];
    moved = Math.max(moved, Math.hypot(dx, dy));
    if (moved < 6) return;
    if (v.s > 1.01) {
      // drag the zoomed map
      mode = 'pan';
      const r = svg().getBoundingClientRect();
      v.x = start.x - dx * (W / v.s) / r.width; v.y = start.y - dy * (H / v.s) / r.height;
      apply();
    } else {
      // normal size: let the page move instead
      if (!mode) mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
      if (mode === 'swipe' && pager) { pager.style.scrollSnapType = 'none'; pager.scrollLeft = start.scrollL - dx; }
      if (mode === 'scroll' && page) page.scrollTop = start.scrollT - dy;
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (moved >= 6) swallowClick = true;
    if (mode === 'swipe' && pager) {
      pager.style.scrollSnapType = '';
      const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
      pager.scrollTo({ left: i * pager.clientWidth, behavior: 'smooth' });
    }
    if (pts.size) { start = { list: [...pts.values()].map((p) => [...p]), s: v.s, x: v.x, y: v.y, scrollL: pager ? pager.scrollLeft : 0, scrollT: page ? page.scrollTop : 0 }; return; }
    if (mode === 'pinch' || mode === 'pan') onSettle && onSettle(v.s);
    start = null; mode = null;
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  // a drag shouldn't also count as a tap on a station or train
  wrap.addEventListener('click', (e) => { if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
  wrap.addEventListener('dblclick', (e) => { e.preventDefault(); zoomAt(2, e.clientX, e.clientY); onSettle && onSettle(v.s); });
  wrap.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY); }, { passive: false });

  // ---- buttons ----
  const btns = document.createElement('div');
  btns.className = 'zbtns';
  btns.innerHTML = `<button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button><button type="button" data-z="reset" aria-label="Show the whole map">⤢</button>`;
  btns.addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.z === 'reset') { v.s = 1; v.x = 0; v.y = 0; apply(); }
    else zoomAt(b.dataset.z === 'in' ? 1.6 : 1 / 1.6, ...centre());
    onSettle && onSettle(v.s);
  });
  wrap.appendChild(btns);
  wrap.classList.add('zoomable');

  return { apply, show, view: v };
}
