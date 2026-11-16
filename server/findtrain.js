// Find a train the way people think of it: "the 17:34 from Glasgow Central". It may have left hours
// ago. We look through today's timetable for passenger trains booked to leave that station at that
// time (where it starts, or anywhere it calls), and link each to the live train if it's running.

import { hhmmOf, nameOfTiploc, OPERATORS } from './timetable.js';

// today's date and the time now in Britain
const ukDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const ukMins = (ms) => { const [h, m] = new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).split(':'); return (+h % 24) * 60 + +m; };

const FREIGHT_CATS = /^(E|J|P|D|B|H)/; // not passenger (same idea as the timetable's own check)
const isPassenger = (s) => s.atoc && s.atoc !== 'ZZ' && !FREIGHT_CATS.test(s.cat || '');

// station code for a timing point: the timetable's own, else CORPUS (big stations have several points)
function crsOf(tt, tip) {
  const t = tt.tiplocs.get(tip);
  if (!t) return null;
  return t.crs || (tt.tiplocCrs && tt.tiplocCrs[tip]) || null;
}

// "17:34" / "1734" -> minutes after midnight
export function minsOf(s) {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(String(s || '').trim());
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}

// stations: list of station codes (e.g. both Glasgow stations); time: "17:34"
// day: -1 yesterday, 0 today, 1 tomorrow (the timetable holds those three days)
// to: optional destination station codes; then only trains that go on to call there, and the time
// only needs to be roughly right (an hour either side)
export function findTrains(nat, stations, time, now = Date.now(), day = 0, to = []) {
  const tt = nat.tt;
  const want = minsOf(time);
  if (!tt || !tt.loadedAt) return { error: 'The timetable is still loading. Try again in a minute.' };
  if (want == null) return { error: 'Give a time like 17:34.' };
  const crsSet = new Set(stations);
  const toSet = new Set(to || []);
  // always offer a choice: from 90 minutes before the time to 2 hours after
  const before = 90, after = 120;
  const date = ukDate(now + day * 86400000), nowM = day < 0 ? 1440 * 2 : day > 0 ? -1 : ukMins(now);
  const sched = tt.byDate.get(date) || new Map();
  // live trains by schedule, so each result can open the running train
  const live = new Map();
  for (const t of nat.trains.values()) if (t.sched) live.set(t.sched.uid + '|' + (t.runDate || date), t);
  const found = [];
  for (const s of sched.values()) {
    if (!isPassenger(s) || !s.locs.length) continue;
    s.locs.forEach((l, i) => {
      if (!crsSet.has(crsOf(tt, l.t))) return;
      const last = i === s.locs.length - 1;
      // a departure we can match: its public time where it has one, else the working time; not a pass
      const dep = last ? null : (l.pdep ?? l.dep);
      if (dep == null) return;
      const gap = Math.abs(dep - want);
      if (dep < want - before || dep > want + after) return;
      // going on to the destination? (a later call there, where it stops)
      let toLoc = null;
      if (toSet.size) {
        for (let j = i + 1; j < s.locs.length && !toLoc; j++) {
          const lj = s.locs[j];
          if (toSet.has(crsOf(tt, lj.t)) && (lj.parr != null || lj.arr != null) && lj.pass == null) toLoc = lj;
        }
        if (!toLoc) return;
      }
      const t = live.get(s.uid + '|' + date) || null;
      const h = !t && nat.history ? nat.history.get(s.uid + '|' + date) : null; // finished: what actually happened
      const o = s.locs[0], d = s.locs[s.locs.length - 1];
      found.push({
        gap, startsHere: i === 0,
        id: t ? t.id : `sch:${s.uid}:${date}`,
        headcode: s.headcode, operator: OPERATORS[s.atoc] || s.atoc,
        station: nameOfTiploc(tt, l.t), dep: hhmmOf(dep),
        origin: nameOfTiploc(tt, o.t), originDep: hhmmOf(o.pdep ?? o.dep),
        dest: nameOfTiploc(tt, d.t), destArr: hhmmOf(d.parr ?? d.arr),
        toName: toLoc ? nameOfTiploc(tt, toLoc.t) : null, toArr: toLoc ? hhmmOf(toLoc.parr ?? toLoc.arr) : null,
        // what it's doing now, from TRUST (only when it's running)
        status: h ? (h.cancelled ? 'Cancelled' : h.terminated ? `Arrived${h.at ? ' ' + h.at.name : ''}` : `Last reported${h.at ? ' at ' + h.at.name : ''}`)
          : !t ? (o.pdep ?? o.dep ?? 0) > nowM ? 'Not started yet' : 'No live reports'
          : t.cancelled ? 'Cancelled' : t.terminated ? 'Arrived' : t.at ? `${t.event === 'Departed' ? 'Left' : 'At'} ${t.at.name}` : 'Running',
        delay: t ? t.delay ?? null : h ? h.delay : null, cancelled: t ? !!t.cancelled : h ? h.cancelled : false
      });
    });
  }
  // exact time first, then nearest; trains starting at the station before ones calling there
  found.sort((a, b) => a.gap - b.gap || (b.startsHere - a.startsHere) || a.dep.localeCompare(b.dep));
  // one row per train (a train can call at two of the 'from' stations)
  const seen = new Set();
  const uniq = found.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
  const exact = uniq.filter((f) => f.gap === 0);
  // every train in the window, in time order; the one nearest the time asked for is marked
  const nearest = uniq.length ? Math.min(...uniq.map((f) => f.gap)) : null;
  const list = uniq.sort((a, b) => a.dep.localeCompare(b.dep)).slice(0, 60).map(({ gap, ...f }) => ({ ...f, nearest: gap === nearest }));
  return { date, day, time: hhmmOf(want), before, after, exact: exact.length, to: toSet.size > 0, trains: list };
}

// A train's page from the timetable alone, for a train that isn't running (yet, or any more)
export function scheduleOnly(nat, id, trainDetail) {
  const [, uid, date] = String(id).split(':');
  const s = (nat.tt.byDate.get(date) || new Map()).get(uid);
  if (!s) return { error: 'That train isn\'t in today\'s timetable.' };
  const running = [...nat.trains.values()].find((t) => t.sched === s);
  if (running) return { redirect: running.id };
  // a finished train: its timetable with every report TRUST made
  const h = nat.history && nat.history.get(uid + '|' + date);
  if (h) {
    const d = trainDetail(nat.tt, { ...h, sched: s });
    d.mode = 'live';
    d.liveNote = 'This train has finished. Times are what Network Rail reported along the way.';
    return d;
  }
  const d = trainDetail(nat.tt, { id, code: s.headcode, sched: s, reports: {}, delay: null });
  d.mode = 'live';
  d.liveNote = 'From the timetable. There are no live reports for this train (not started yet, or it ran before the app last restarted).';
  return d;
}
