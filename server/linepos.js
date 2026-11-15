// Which stretch of a line each train is on — from the train's own timetable and TRUST reports,
// not from where it sits on the map.
//
// A line is a list of stations (e.g. Newcastle, Morpeth, Alnmouth, Berwick, Dunbar, Edinburgh).
// From the day's timetable we learn every timing point between each pair of neighbouring stations:
// every station, junction and passing point any train is booked through on the way. A train is on
// that stretch when the last point TRUST reported it at is one of them. So a delay reported at
// Chathill or Tweedmouth counts on the Alnmouth–Berwick stretch even though neither is drawn.
//
// A train's direction comes from its own timetable (which way it runs through the line's
// stations) or from its next booked point; with neither, it still counts towards the stretch's
// average but isn't put in the up or down column.

const corridors = new Map(); // cache: line stations + timetable load time -> corridor

// station code -> the schedules that call at or pass it (built once per timetable load)
let stIdx = null, stIdxAt = -1;
function stationIndex(tt) {
  if (stIdx && stIdxAt === tt.loadedAt) return stIdx;
  stIdx = new Map(); stIdxAt = tt.loadedAt;
  for (const day of tt.byDate.values()) for (const s of day.values()) {
    for (const l of s.locs) {
      const c = (tt.tiplocs.get(l.t) || {}).crs;
      if (!c) continue;
      let list = stIdx.get(c);
      if (!list) stIdx.set(c, (list = []));
      if (list[list.length - 1] !== s) list.push(s);
    }
  }
  return stIdx;
}

// timing point -> position along the line (station i = i; between i and i+1 = i + fraction)
export function corridor(tt, crsList) {
  const key = crsList.join(' ') + '@' + (tt.loadedAt || 0);
  const hit = corridors.get(key);
  if (hit) return hit;
  const lineIdx = new Map(crsList.map((c, i) => [c, i]));
  const pos = new Map();
  const crsOf = (tip) => (tt.tiplocs.get(tip) || {}).crs || null;
  // only the schedules that call at or pass one of the line's stations
  const idx = stationIndex(tt);
  const touching = new Set();
  for (const c of crsList) for (const s of idx.get(c) || []) touching.add(s);
  {
    for (const s of touching) {
      // the line's stations in this train's schedule, as runs of schedule rows (a big station can have several timing points)
      const keys = [];
      s.locs.forEach((l, i) => {
        const li = lineIdx.get(crsOf(l.t));
        if (li == null) return;
        const last = keys[keys.length - 1];
        if (last && last.li === li && last.end === i - 1) last.end = i;
        else keys.push({ li, start: i, end: i });
      });
      for (const k of keys) for (let i = k.start; i <= k.end; i++) if (!pos.has(s.locs[i].t)) pos.set(s.locs[i].t, k.li);
      // every timing point between two neighbouring line stations belongs to that stretch
      for (let j = 0; j < keys.length - 1; j++) {
        const a = keys[j], b = keys[j + 1];
        if (Math.abs(a.li - b.li) !== 1) continue;
        const span = b.start - a.end;
        for (let i = a.end + 1; i < b.start; i++) {
          const tip = s.locs[i].t;
          if (pos.has(tip)) continue;
          pos.set(tip, a.li + (b.li - a.li) * ((i - a.end) / span));
        }
      }
    }
  }
  // and by station code, for trains we have no schedule for
  const byCrs = new Map();
  for (const [tip, p] of pos) { const c = crsOf(tip); if (c && !byCrs.has(c)) byCrs.set(c, p); }
  const out = { pos, byCrs, n: crsList.length };
  corridors.set(key, out);
  if (corridors.size > 200) corridors.delete(corridors.keys().next().value);
  return out;
}

const stanoxOf = (tt, tip) => (tt.tiplocs.get(tip) || {}).stanox || null;

// Every train on the line now: { id, code, toc, dest, delay, cancelled, band, pos, dir, last }
// memo: pass the same Map for several lines in one request, so each train's last point is found once
export function trainsOnLine(nat, crsList, band, now = Date.now(), memo = new Map()) {
  const tt = nat.tt;
  if (!tt || !tt.loadedAt) return null;
  const cor = corridor(tt, crsList);
  const out = [];
  for (const t of nat.trains.values()) {
    if (t.terminated && now - t.updated > 10 * 60000) continue;
    let p = null, dir = null, departed = t.event === 'Departed', last = t.at ? t.at.name : null;
    const s = t.sched;
    if (s) {
      // the furthest point in its schedule TRUST has reported it at
      const rep = t.reports || {};
      let li = memo.get(t.id);
      if (li == null) { li = -1; s.locs.forEach((l, i) => { const sx = stanoxOf(tt, l.t); if (sx && rep[sx]) li = i; }); memo.set(t.id, li); }
      if (li < 0) continue;
      const tip = s.locs[li].t;
      p = cor.pos.get(tip);
      if (p == null) continue;
      const r = rep[stanoxOf(tt, tip)] || {};
      departed = r.dep != null;
      last = (tt.tiplocs.get(tip) || {}).name || last;
      // direction: the next (or previous) point in its schedule that's on this line
      for (let j = li + 1; j < s.locs.length && !dir; j++) { const q = cor.pos.get(s.locs[j].t); if (q != null && q !== p) dir = q > p ? 'down' : 'up'; }
      for (let j = li - 1; j >= 0 && !dir; j--) { const q = cor.pos.get(s.locs[j].t); if (q != null && q !== p) dir = p > q ? 'down' : 'up'; }
    } else if (t.at) {
      p = cor.byCrs.get(t.at.crs);
      if (p == null) continue;
      const q = t.next ? cor.byCrs.get(t.next.crs) : null;
      if (q != null && q !== p) dir = q > p ? 'down' : 'up';
    } else continue;
    // at a line station: a train that has left is on the stretch ahead; one that has arrived, the stretch behind
    if (Number.isInteger(p) && dir) p += (dir === 'down') === departed ? 0.001 : -0.001;
    p = Math.min(cor.n - 1.001, Math.max(0, p));
    out.push({ id: t.id, code: t.code, toc: t.toc, dest: t.destName || null, delay: t.delay ?? null, cancelled: !!t.cancelled, band: band(t), pos: Math.round(p * 1000) / 1000, dir, last });
  }
  return out;
}
