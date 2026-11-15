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
  // pass 1: for each stretch, the fewest timing points any train is booked through between its two
  // stations. A schedule that wanders off between them (an empty stock working round London, say) is
  // much longer than that and isn't used, so it can't put another line's points on this stretch.
  const keysOf = (s) => {
    const keys = [];
    s.locs.forEach((l, i) => {
      const li = lineIdx.get(crsOf(l.t));
      if (li == null) return;
      const last = keys[keys.length - 1];
      if (last && last.li === li && last.end === i - 1) last.end = i;
      else keys.push({ li, start: i, end: i });
    });
    return keys;
  };
  const shortest = new Map();
  for (const s of touching) {
    const keys = keysOf(s);
    for (let j = 0; j < keys.length - 1; j++) {
      const a = keys[j], b = keys[j + 1];
      if (Math.abs(a.li - b.li) !== 1) continue;
      const seg = Math.min(a.li, b.li), span = b.start - a.end;
      if (!shortest.has(seg) || span < shortest.get(seg)) shortest.set(seg, span);
    }
  }
  const direct = new Map(); // stretch -> how many schedules run straight between its two stations
  const ok = (seg, span) => span <= Math.ceil(shortest.get(seg) * 1.5) + 4;
  {
    for (const s of touching) {
      // the line's stations in this train's schedule, as runs of schedule rows (a big station can have several timing points)
      const keys = keysOf(s);
      for (const k of keys) for (let i = k.start; i <= k.end; i++) if (!pos.has(s.locs[i].t)) pos.set(s.locs[i].t, k.li);
      // every timing point between two neighbouring line stations belongs to that stretch
      for (let j = 0; j < keys.length - 1; j++) {
        const a = keys[j], b = keys[j + 1];
        if (Math.abs(a.li - b.li) !== 1) continue;
        const span = b.start - a.end;
        if (!ok(Math.min(a.li, b.li), span)) continue;
        direct.set(Math.min(a.li, b.li), (direct.get(Math.min(a.li, b.li)) || 0) + 1);
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
  const keyTips = new Set([...tt.tiplocs.entries()].filter(([, v]) => v.crs && lineIdx.has(v.crs)).map(([k]) => k));
  const out = { pos, byCrs, keyTips, direct, n: crsList.length };
  corridors.set(key, out);
  if (corridors.size > 200) corridors.delete(corridors.keys().next().value);
  return out;
}

// STANOX codes compared as numbers: the timetable and TRUST don't always agree on leading zeros
const norm = (x) => (x == null || x === '' ? null : String(Number(x)));
const stanoxOf = (tt, tip) => norm((tt.tiplocs.get(tip) || {}).stanox);
const reportsOf = (t) => {
  const out = {};
  for (const [k, v] of Object.entries(t.reports || {})) out[norm(k)] = v;
  return out;
};

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
      const rep = reportsOf(t);
      let li = memo.get(t.id);
      if (li == null) { li = -1; s.locs.forEach((l, i) => { const sx = stanoxOf(tt, l.t); if (sx && rep[sx]) li = i; }); memo.set(t.id, li); }
      if (li < 0) continue;
      const tip = s.locs[li].t;
      p = cor.pos.get(tip);
      if (p == null) continue;
      // only trains that run along this route themselves: their own schedule calls at or passes at
      // least one of its stations (so a Moorgate train sharing the tracks at Finsbury Park isn't counted)
      if (!s.locs.some((l) => cor.keyTips.has(l.t))) continue;
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

// What happened for one line, step by step (for /api/route-trains?debug=1)
export function lineDebug(nat, crsList) {
  const tt = nat.tt;
  const cor = corridor(tt, crsList);
  let trains = 0, withSched = 0, reported = 0, onLine = 0;
  let sample = null;
  for (const t of nat.trains.values()) {
    trains++;
    if (!t.sched) continue;
    withSched++;
    const rep = reportsOf(t);
    let li = -1;
    t.sched.locs.forEach((l, i) => { const sx = stanoxOf(tt, l.t); if (sx && rep[sx]) li = i; });
    if (li >= 0) reported++; else if (!sample && Object.keys(rep).length) sample = { reportKeys: Object.keys(t.reports || {}).slice(0, 5), schedStanox: t.sched.locs.slice(0, 5).map((l) => (tt.tiplocs.get(l.t) || {}).stanox ?? null) };
    if (li >= 0 && cor.pos.has(t.sched.locs[li].t)) onLine++;
  }
  const keys = crsList.map((c) => ({ crs: c, tiplocs: [...tt.tiplocs.entries()].filter(([, v]) => v.crs === c).map(([k, v]) => k + ':' + v.stanox) }));
  return { timetableSchedules: tt.schedules, timingPointsOnLine: cor.pos.size, lineStations: keys, trains, withSched, reportedOnSchedule: reported, onLine, unmatchedSample: sample };
}

// A health check for a line: for each stretch, how many trains are booked straight between its two
// stations, how many timing points lie between them, and how many trains are on it now. A stretch
// no train is booked straight through points to a wrong station order or a missing station.
export function lineCheck(nat, line, band) {
  const tt = nat.tt;
  const cor = corridor(tt, line.crs);
  const placed = trainsOnLine(nat, line.crs, band) || [];
  const stretches = [];
  for (let i = 0; i < line.crs.length - 1; i++) {
    let points = 0;
    for (const p of cor.pos.values()) if (p > i && p < i + 1) points++;
    const here = placed.filter((t) => t.pos >= i && t.pos < i + 1);
    stretches.push({ from: line.crs[i], to: line.crs[i + 1], bookedThrough: cor.direct.get(i) || 0, pointsBetween: points, trainsNow: here.length,
      noDirection: here.filter((t) => !t.dir).length, problem: (cor.direct.get(i) || 0) === 0 ? 'no train is booked straight between these two stations' : null });
  }
  return { id: line.id, name: line.name, trainsNow: placed.length, problems: stretches.filter((x) => x.problem).length, stretches };
}
