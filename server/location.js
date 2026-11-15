// Location boards: any timing point, not just stations: a junction, a yard, a passing loop.
// Every train booked through it today (passenger, empty and freight) from the timetable, with
// what TRUST actually reported there: the time it passed and how late it was. A train that's
// running but hasn't got there yet shows its current lateness from TRUST; nothing is estimated.

import { hhmmOf, wttOf, nameOfTiploc, normStanox, OPERATORS } from './timetable.js';

const ukDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const ukMins = (ms) => { const [h, m] = new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).split(':'); return (+h % 24) * 60 + +m; };
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
const FREIGHT = /^(E|J|P|D|B|H)/;

// Search timing points by name or code: "decoy", "DONCDCY", "Colton"
export function searchLocations(tt, q, limit = 20) {
  const s = String(q || '').trim().toUpperCase();
  if (s.length < 3) return [];
  const out = [];
  for (const [tip, t] of tt.tiplocs) {
    const name = (t.name || '').toUpperCase();
    const score = tip === s ? 0 : tip.startsWith(s) ? 1 : name.startsWith(s) ? 2 : name.includes(s) ? 3 : -1;
    if (score < 0) continue;
    out.push({ score, tiploc: tip, name: nameOfTiploc(tt, tip), crs: t.crs || (tt.tiplocCrs && tt.tiplocCrs[tip]) || null });
  }
  return out.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, limit).map(({ score, ...r }) => r);
}

// The board for one timing point: trains from an hour ago to two hours ahead
export function locationBoard(nat, tiploc, now = Date.now()) {
  const tt = nat.tt;
  if (!tt || !tt.loadedAt) return { error: 'The timetable is still loading. Try again in a minute.' };
  const tl = tt.tiplocs.get(tiploc);
  if (!tl) return { error: 'Unknown location.' };
  const date = ukDate(now), nowM = ukMins(now);
  const sx = normStanox(tl.stanox);
  const live = new Map();
  for (const t of nat.trains.values()) if (t.sched) live.set(t.sched.uid + '|' + (t.runDate || date), t);
  const rows = [];
  for (const s of (tt.byDate.get(date) || new Map()).values()) {
    s.locs.forEach((l, i) => {
      if (l.t !== tiploc) return;
      const m = l.pass ?? l.dep ?? l.arr;
      if (m == null || m < nowM - 60 || m > nowM + 120) return;
      const t = live.get(s.uid + '|' + date) || null;
      const rep = t && sx ? (t.reports || {})[sx] : null;
      const o = s.locs[0], d = s.locs[s.locs.length - 1];
      const kind = i === 0 ? 'starts' : i === s.locs.length - 1 ? 'ends' : l.pass != null ? 'passes' : 'calls';
      rows.push({
        m, id: t ? t.id : `sch:${s.uid}:${date}`, headcode: s.headcode, operator: OPERATORS[s.atoc] || s.atoc || null,
        freight: !s.atoc || s.atoc === 'ZZ' || FREIGHT.test(s.cat || ''), kind,
        booked: wttOf(m), line: l.line || null, platform: l.plat || null,
        from: nameOfTiploc(tt, o.t), fromTime: hhmmOf(o.dep), to: nameOfTiploc(tt, d.t), toTime: hhmmOf(d.arr),
        // what actually happened here (TRUST), or how the train is doing if it hasn't got here yet
        actual: rep ? clock(rep.dep ?? rep.arr ?? rep.at) : null,
        src: rep ? (rep.srcDep || rep.srcArr || null) : null,
        late: rep ? (rep.lateDep ?? rep.lateArr ?? null) : null,
        nowLate: !rep && t ? t.delay ?? null : null,
        state: rep ? 'passed' : t ? (t.cancelled ? 'cancelled' : 'running') : m < nowM ? 'noreport' : 'due',
        at: !rep && t && t.at ? `${t.event === 'Departed' ? 'left' : 'at'} ${t.at.name}` : null
      });
    });
  }
  rows.sort((a, b) => a.m - b.m);
  return { mode: 'live', tiploc, name: nameOfTiploc(tt, tiploc), crs: tl.crs || (tt.tiplocCrs && tt.tiplocCrs[tiploc]) || null, rows: rows.map(({ m, ...r }) => r) };
}
