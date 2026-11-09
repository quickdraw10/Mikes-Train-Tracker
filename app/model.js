// The shared data model. The data service fills a "raw" state from the
// signalling (TD) and movement (TRUST) feeds; buildView() turns it into
// exactly what designs A and C draw. The in-browser demo uses the same code.

import { PANELS, ROUTES } from './layout.js';

export const TRAIN_STALE_MS = 45 * 60 * 1000;   // drop route trains not heard from for 45 min
export const SECTION_MEMORY_MS = 20 * 60 * 1000; // a section keeps the last train's delay for 20 min

export function emptyState() {
  return { berths: {}, trains: {}, sections: {}, updated: 0, mode: 'demo' };
}

export function train(raw, code) {
  if (!raw.trains[code]) raw.trains[code] = { code, delay: null, routes: {}, seen: Date.now() };
  return raw.trains[code];
}

// Delay bands used by every design: ok = on time, mid = 2–9 late, bad = 10+ or cancelled
export function band(t) {
  if (!t) return 'none';
  if (t.cancelled) return 'bad';
  if (t.delay == null) return 'none';
  if (t.delay >= 10) return 'bad';
  if (t.delay >= 2) return 'mid';
  return 'ok';
}

// The signal at the far end of a berth: 'on' (red), 'off' (proceed) or null (not known).
// Live: read from the S-Class bits via the decoded map (data/signals-<AREA>.json).
// Demo: the simulator sets raw.signals directly.
export function signalState(raw, area, berth) {
  const forced = raw.signals && raw.signals[area + ':' + berth];
  if (forced) return forced;
  const map = raw.signalMap && raw.signalMap[area] && raw.signalMap[area][berth];
  const bytes = raw.sbits && raw.sbits[area];
  if (!map || !bytes || bytes[map.address] === undefined) return null;
  let bit = (bytes[map.address] >> map.bit) & 1;
  if (map.invert) bit ^= 1;
  return bit ? 'off' : 'on';
}

export function buildView(raw, now = Date.now(), panelDefs = PANELS) {
  const panels = panelDefs.map((p) => {
    const late = [];
    const tracks = p.tracks.map((t) => ({
      name: t.name,
      dir: t.dir,
      berths: t.berths.map((bd, i) => {
        const id = typeof bd === 'string' ? bd : bd.id;
        const code = raw.berths[p.area + ':' + id] || null;
        const tr = code ? raw.trains[code] : null;
        const b = { id, col: bd.col ?? i, kind: bd.kind || 'line', code, delay: tr ? tr.delay : null, band: code ? band(tr) : 'empty', signal: signalState(raw, p.area, id) };
        if (code && tr && (tr.cancelled || tr.delay >= 2)) late.push({ code, delay: tr.delay, cancelled: !!tr.cancelled, desc: tr.desc || null, track: t.name });
        return b;
      })
    }));
    late.sort((a, b) => (b.delay || 0) - (a.delay || 0));
    const heard = raw.areaSeen && raw.areaSeen[p.area];
    // Live only: an area that has sent nothing (not even a heartbeat) for 5 minutes is probably down
    const quietMins = raw.mode === 'live' ? (heard ? Math.floor((now - heard) / 60000) : null) : 0;
    return { id: p.id, name: p.name, subtitle: p.subtitle, area: p.area, ends: p.ends, style: p.style || null, note: p.note || null, tracks, late, quietMins };
  });

  const routes = ROUTES.map((r) => {
    const n = r.stations.length;
    const trains = [];
    for (const t of Object.values(raw.trains)) {
      const rp = t.routes && t.routes[r.id];
      if (!rp || t.terminated || now - rp.at > TRAIN_STALE_MS) continue;
      trains.push({ code: t.code, dir: rp.dir, pos: rp.pos, delay: t.delay, cancelled: !!t.cancelled, band: band(t), desc: t.desc || null, last: t.last || null });
    }
    const sections = {};
    for (const dir of ['down', 'up']) {
      sections[dir] = [];
      for (let i = 0; i < n - 1; i++) {
        const inside = trains.filter((t) => t.dir === dir && t.pos > i && t.pos < i + 1);
        let delay = null;
        if (inside.length) delay = Math.max(...inside.map((t) => t.delay ?? 0));
        else {
          const h = raw.sections[r.id + ':' + dir + ':' + i];
          if (h && now - h.at < SECTION_MEMORY_MS) delay = h.delay;
        }
        sections[dir].push({ delay, band: band(delay == null ? null : { delay }) });
      }
    }
    const known = trains.filter((t) => t.delay != null);
    const avg = known.length ? Math.round(known.reduce((s, t) => s + Math.max(0, t.delay), 0) / known.length) : null;
    const lateCount = known.filter((t) => t.delay >= 2 || t.cancelled).length;
    const worst = [...known].sort((a, b) => b.delay - a.delay)[0] || null;
    return { id: r.id, name: r.name, stations: r.stations.map((s) => s.name), trains, sections, summary: { avg, lateCount, total: trains.length, worst } };
  });

  return { mode: raw.mode, updated: raw.updated || now, panels, routes };
}
