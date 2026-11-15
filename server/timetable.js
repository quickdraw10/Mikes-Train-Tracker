// The national timetable (Network Rail SCHEDULE feed, daily full JSON extract).
// Gives each live train its origin, destination, operator and calling points.
//
// The file has one JSON record per line: TiplocV1 (timing point names and
// STANOX codes), JsonScheduleV1 (one train's timetable, valid on certain days)
// and others we ignore. It is large, so it is read as a stream and only the
// schedules that run yesterday, today or tomorrow are kept.
// Published daily from about 06:00; reloaded each morning.

import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable, pipeline } from 'node:stream';
import { BY_CRS } from '../app/geo.js';

const URL_SCHEDULE = process.env.NR_SCHEDULE_URL || 'https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full';

export { OPERATORS } from '../app/operators.js';
import { OPERATORS } from '../app/operators.js';
const FREIGHT_CATS = /^[ADEH]|^J|^P[ABCDEFGHJKLMNPQRSTUVWXYZ]?$/;

// "0718H" -> 438.5 minutes after midnight; empty -> null
export function mins(t) {
  if (!t || typeof t !== 'string' || t.length < 4) return null;
  const h = Number(t.slice(0, 2)), m = Number(t.slice(2, 4));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m + (t[4] === 'H' ? 0.5 : 0);
}
// working timetable times keep their half minutes: 438.5 -> "07:18½"
export const wttOf = (m) => (m == null ? null : hhmmOf(m) + (m % 1 ? '½' : ''));
export const hhmmOf = (m) => m == null ? null : String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(Math.floor(m % 60)).padStart(2, '0');

export function londonDate(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (date) => (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7; // Monday = 0

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bJn\b/, 'Jn').trim();
}

export function createTimetable() {
  return { tiplocs: new Map(), stanoxName: new Map(), dates: [], byDate: new Map(), byHeadcode: new Map(), loadedAt: null, schedules: 0 };
}

// One public time: "0000" means "not a public stop" unless the train really is there at midnight
function pub(p, working) {
  if (!p) return null;
  if (p === '0000' && !(working && /^(23|00)/.test(working))) return null;
  return mins(p);
}

function compact(rec) {
  const seg = rec.schedule_segment || {};
  const locs = (seg.schedule_location || []).map((l) => ({
    t: (l.tiploc_code || '').trim(),
    arr: mins(l.arrival), dep: mins(l.departure), pass: mins(l.pass),
    parr: pub(l.public_arrival, l.arrival), pdep: pub(l.public_departure, l.departure),
    plat: l.platform || null, type: l.location_type,
    line: (l.line || '').trim() || null, path: (l.path || '').trim() || null
  }));
  return {
    uid: rec.CIF_train_uid, stp: rec.CIF_stp_indicator, atoc: rec.atoc_code || null,
    headcode: seg.signalling_id || null, cat: seg.CIF_train_category || null, locs,
    // how the train is timed (e.g. EMU, class 390, 125 mph) and what's on board, from the timetable
    power: seg.CIF_power_type || null, load: (seg.CIF_timing_load || '').trim() || null, speed: Number(seg.CIF_speed) || null,
    tclass: seg.CIF_train_class || null, catering: seg.CIF_catering_code || null, resv: seg.CIF_reservations || null, sleepers: seg.CIF_sleepers || null
  };
}

// Feed one parsed line in. `pending` collects candidates per date+uid.
export function ingest(obj, tt, pending) {
  if (obj.TiplocV1) {
    const t = obj.TiplocV1;
    const code = (t.tiploc_code || '').trim();
    const crs = (t.crs_code || '').trim() || null;
    const stanox = t.stanox ? String(t.stanox).trim() : null;
    const name = (crs && BY_CRS.get(crs) && BY_CRS.get(crs).name) || titleCase(t.tps_description || t.description || code);
    tt.tiplocs.set(code, { stanox, crs, name });
    if (stanox && (crs || !tt.stanoxName.has(stanox))) tt.stanoxName.set(stanox, name);
    return;
  }
  const rec = obj.JsonScheduleV1;
  if (!rec || rec.transaction_type === 'Delete') return;
  const runs = rec.schedule_days_runs || '';
  let s = null;
  for (const date of tt.dates) {
    if (date < rec.schedule_start_date || date > rec.schedule_end_date) continue;
    if (runs[weekday(date)] !== '1') continue;
    const key = date + '|' + rec.CIF_train_uid;
    const have = pending.get(key);
    // The applicable schedule for a day is the one with the lowest STP letter (C, N, O beat P)
    if (have && have.stp <= rec.CIF_stp_indicator) continue;
    s ||= compact(rec);
    pending.set(key, s);
  }
}

export function finish(tt, pending) {
  tt.byDate = new Map(tt.dates.map((d) => [d, new Map()]));
  tt.byHeadcode = new Map(tt.dates.map((d) => [d, new Map()]));
  let n = 0;
  for (const [key, s] of pending) {
    if (s.stp === 'C') continue; // cancelled that day
    const date = key.slice(0, 10);
    tt.byDate.get(date).set(s.uid, s);
    if (s.headcode) {
      const m = tt.byHeadcode.get(date);
      if (!m.has(s.headcode)) m.set(s.headcode, []);
      m.get(s.headcode).push(s);
    }
    n++;
  }
  tt.schedules = n;
  tt.loadedAt = Date.now();
}

// Unzips the download if it starts with the gzip signature, otherwise passes it through
export async function openMaybeGzip(webStream) {
  const reader = webStream.getReader();
  const first = await reader.read();
  async function* all() {
    if (!first.done) yield Buffer.from(first.value);
    for (;;) { const r = await reader.read(); if (r.done) return; yield Buffer.from(r.value); }
  }
  const src = Readable.from(all());
  const gz = !first.done && first.value[0] === 0x1f && first.value[1] === 0x8b;
  if (!gz) return src;
  const gunzip = zlib.createGunzip();
  pipeline(src, gunzip, () => {});
  return gunzip;
}

export async function loadTimetable(tt, { user, pass, log = console.log, now = Date.now() }) {
  const today = londonDate(now);
  tt.dates = [addDays(today, -1), today, addDays(today, 1)];
  log('[timetable] downloading the national timetable…');
  const res = await fetch(URL_SCHEDULE, { headers: { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const rl = readline.createInterface({ input: await openMaybeGzip(res.body), crlfDelay: Infinity });
  const pending = new Map();
  let lines = 0;
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    try { ingest(JSON.parse(line), tt, pending); } catch { /* skip a bad line */ }
  }
  finish(tt, pending);
  log(`[timetable] read ${lines} records; ${tt.schedules} train schedules for ${tt.dates.join(', ')}; ${tt.tiplocs.size} timing points`);
}

// ---------- matching a live train to its schedule ----------

// STANOX codes are compared as numbers: the timetable and TRUST don't agree on leading zeros
// (Edinburgh is 04303 in one and 4303 in the other), which matters most in Scotland
export const normStanox = (x) => (x == null || x === '' ? null : String(Number(x)));
const stanoxOf = (tt, tiploc) => normStanox((tt.tiplocs.get(tiploc) || {}).stanox);
export const nameOfTiploc = (tt, tiploc) => (tt.tiplocs.get(tiploc) || {}).name || tiploc;

// TRUST timestamps are London wall-clock written as if UTC, so the UTC fields read local time
export const wallMins = (raw) => { const d = new Date(Number(raw)); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const wallDate = (raw) => new Date(Number(raw)).toISOString().slice(0, 10);

export function byUid(tt, uid, date) {
  const m = tt.byDate.get(date);
  return m ? m.get(uid) || null : null;
}

// Find the schedule for a train we didn't see start: same headcode, calling or
// passing at this STANOX within 30 minutes of the planned time.
export function matchByHeadcode(tt, headcode, stanox, plannedRaw) {
  const date = wallDate(plannedRaw);
  const t = wallMins(plannedRaw) + 1440; // minutes from the start of yesterday
  let best = null, bestGap = 31;
  for (const [d, dayStart] of [[date, 1440], [addDays(date, -1), 0]]) {
    for (const s of (tt.byHeadcode.get(d) || new Map()).get(headcode) || []) {
      const first = s.locs[0] ? (s.locs[0].dep ?? s.locs[0].arr ?? 0) : 0;
      for (const l of s.locs) {
        if (stanoxOf(tt, l.t) !== normStanox(stanox)) continue;
        const sm = l.dep ?? l.pass ?? l.arr;
        if (sm == null) continue;
        // times after midnight on an overnight train belong to the next day
        const abs = dayStart + sm + (sm < first ? 1440 : 0);
        const gap = Math.abs(abs - t);
        if (gap < bestGap) { best = { s, date: d }; bestGap = gap; }
      }
    }
  }
  return best;
}

const isPassenger = (s) => s.atoc && s.atoc !== 'ZZ' && !FREIGHT_CATS.test(s.cat || '');

// Everything the train screen needs, from the schedule plus what TRUST has reported
export function trainDetail(tt, t) {
  const out = {
    id: t.id, code: t.code, delay: t.delay ?? null, cancelled: !!t.cancelled, terminated: !!t.terminated,
    operator: t.toc || null, origin: t.originName || null, dest: null, next: null, stops: [], matched: false,
    last: t.at ? { name: t.at.name, event: t.event, at: t.eventAt } : null
  };
  const s = t.sched;
  if (!s) return out;
  out.matched = true;
  out.operator = OPERATORS[s.atoc] || out.operator || null;
  out.passenger = isPassenger(s);
  // "Timed as Class 390 EMU at 125 mph": the timing the path was planned for (not a guarantee of the actual unit)
  out.timing = { power: s.power || null, load: s.load || null, speed: s.speed || null };
  out.onboard = { firstClass: s.tclass === 'B' || s.tclass === ' ' ? true : s.tclass === 'S' ? false : null, catering: s.catering || null, reservations: s.resv || null, sleepers: s.sleepers || null };
  out.origin = nameOfTiploc(tt, s.locs[0].t);
  out.dest = nameOfTiploc(tt, s.locs[s.locs.length - 1].t);

  // Where the train has got to: the furthest schedule point it has reported at
  let lastIdx = -1;
  const reported = t.reports || {};
  s.locs.forEach((l, i) => { const sx = stanoxOf(tt, l.t); if (sx && reported[sx]) lastIdx = i; });

  const delay = t.delay ?? 0;
  s.locs.forEach((l, i) => {
    const isEnd = i === 0 || i === s.locs.length - 1;
    const publicStop = l.parr != null || l.pdep != null;
    if (!isEnd && !(out.passenger ? publicStop : (l.arr != null || l.dep != null))) return;
    const booked = (i === 0 ? (l.pdep ?? l.dep) : (l.parr ?? l.arr ?? l.pdep ?? l.dep));
    const sx = stanoxOf(tt, l.t);
    const rep = sx && reported[sx];
    const passed = i <= lastIdx;
    const stop = {
      name: nameOfTiploc(tt, l.t), crs: (tt.tiplocs.get(l.t) || {}).crs || null, booked: hhmmOf(booked), platform: l.plat,
      // the actual time and TRUST's own lateness there: arrival for calls, departure at the start
      actual: rep ? (i === 0 ? rep.dep ?? rep.at : rep.arr ?? rep.dep ?? rep.at) : null,
      late: rep ? (i === 0 ? rep.lateDep ?? rep.lateArr : rep.lateArr ?? rep.lateDep) ?? null : null,
      state: passed ? 'passed' : 'due',
      expected: !passed && booked != null && !t.cancelled ? hhmmOf(booked + Math.max(0, delay)) : null
    };
    out.stops.push(stop);
    if (!passed && !out.next && i > 0) out.next = stop;
  });

  // Every timing point, for the Detailed view and the journey strip: stations, junctions and passing
  // points with the working timetable, public times, platform and line, and TRUST's actual times,
  // lateness and how each was reported (automatic from the signalling, or keyed in manually).
  const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }) : null);
  out.points = s.locs.map((l, i) => {
    const sx = stanoxOf(tt, l.t);
    const rep = sx && reported[sx];
    const kind = i === 0 ? 'origin' : i === s.locs.length - 1 ? 'dest' : l.pass != null ? 'pass' : (l.parr != null || l.pdep != null) ? 'stop' : 'call';
    return {
      name: nameOfTiploc(tt, l.t), tiploc: l.t, crs: (tt.tiplocs.get(l.t) || {}).crs || null, kind,
      wtt: { arr: wttOf(l.arr), dep: wttOf(l.dep), pass: wttOf(l.pass) }, pub: { arr: hhmmOf(l.parr), dep: hhmmOf(l.pdep) },
      platform: (rep && rep.platform) || l.plat || null, line: (rep && rep.line) || l.line || null, path: l.path || null,
      actual: rep ? { arr: clock(rep.arr), dep: clock(rep.dep), srcArr: rep.srcArr || null, srcDep: rep.srcDep || null } : null,
      late: rep ? (rep.lateDep ?? rep.lateArr ?? null) : null,
      passed: i <= lastIdx
    };
  });
  return out;
}
