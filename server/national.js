// Every train in the country, from the movements (TRUST) feed, for the map.
// A train is placed at the last station it reported from. Once it has departed
// it is moved along towards its next reporting point using the feed's own
// running-time estimate, so it creeps along the line between reports.
// Timing points that are not stations (junctions, sidings) have no map position:
// the train keeps its last station position but its delay still updates.

import { BY_CRS, km, inBox } from '../app/geo.js';
import { band } from '../app/model.js';
import { headcodeOf, delayOf, trustTime } from './trust.js';
import { staffBoard, staffEnabled, findService, serviceToLive } from './staff.js';
import { byUid, matchByHeadcode, nameOfTiploc, trainDetail, wallDate, OPERATORS } from './timetable.js';

const TOCS = { '84': 'South Western Railway', '88': 'GTR' };
const LOG_MAX = 20000;

export function createNational(tt = null) {
  // tt: the timetable (timetable.js), used to name origin, destination and stops
  return { trains: new Map(), log: [], tt };
}

function trainFor(nat, id) {
  let t = nat.trains.get(id);
  if (!t) { t = { id, code: headcodeOf(id), toc: null, delay: null, reports: {} }; nat.trains.set(id, t); }
  return t;
}

// Activation: TRUST tells us which timetable entry (UID) this train is running
function activate(nat, t, b) {
  t.uid = b.train_uid || null;
  t.runDate = b.origin_dep_timestamp ? wallDate(b.origin_dep_timestamp) : null;
  const sx = b.sched_origin_stanox || b.tp_origin_stanox;
  if (sx && nat.tt) t.originName = nat.tt.stanoxName.get(sx) || null;
  attach(nat, t);
}

// Link the train to its schedule if the timetable is loaded
function attach(nat, t, b) {
  if (t.sched || !nat.tt || !nat.tt.loadedAt) return;
  if (t.uid && t.runDate) t.sched = byUid(nat.tt, t.uid, t.runDate);
  b ||= t.lastMove;
  if (!t.sched && b && b.loc_stanox && b.planned_timestamp) {
    const m = matchByHeadcode(nat.tt, t.code, b.loc_stanox, b.planned_timestamp);
    if (m) { t.sched = m.s; t.uid = m.s.uid; t.runDate = m.date; }
  }
  if (t.sched) {
    const locs = t.sched.locs;
    t.originName = nameOfTiploc(nat.tt, locs[0].t);
    t.destName = nameOfTiploc(nat.tt, locs[locs.length - 1].t);
    t.toc = OPERATORS[t.sched.atoc] || t.toc;
  }
}

export function handleNational(batch, nat, stanoxCrs, now = Date.now()) {
  let changed = false;
  for (const msg of batch) {
    const type = msg.header && msg.header.msg_type;
    const b = msg.body || {};
    const id = b.train_id;
    if (!id) continue;
    if (type === '0002') { const t = nat.trains.get(id); if (t) { t.cancelled = true; t.updated = now; changed = true; } continue; }
    if (type === '0005') { const t = nat.trains.get(id); if (t) { t.cancelled = false; t.updated = now; changed = true; } continue; }
    if (type === '0007') {
      const t = nat.trains.get(id);
      if (t && b.revised_train_id) { nat.trains.delete(id); t.id = b.revised_train_id; t.code = headcodeOf(b.revised_train_id); nat.trains.set(t.id, t); changed = true; }
      continue;
    }
    if (type === '0001') { activate(nat, trainFor(nat, id), b); continue; }
    if (type !== '0003') continue;

    const t = trainFor(nat, id);
    t.delay = delayOf(b);
    if (b.loc_stanox) {
      const at = trustTime(b.actual_timestamp) || now;
      (t.reports[b.loc_stanox] ||= {})[b.event_type === 'DEPARTURE' ? 'dep' : 'arr'] = at;
      t.reports[b.loc_stanox].at = at;
    }
    if (b.planned_timestamp) t.lastMove = { loc_stanox: b.loc_stanox, planned_timestamp: b.planned_timestamp };
    attach(nat, t, b);
    if (b.toc_id) t.toc = TOCS[b.toc_id] || null;
    t.updated = now;
    t.terminated = b.train_terminated === 'true';
    const crs = stanoxCrs[b.loc_stanox];
    const stn = crs && BY_CRS.get(crs);
    if (stn) {
      const departed = b.event_type === 'DEPARTURE';
      const at = trustTime(b.actual_timestamp) || now;
      t.at = stn; t.event = departed ? 'Departed' : t.terminated ? 'Arrived (terminates)' : 'Arrived'; t.eventAt = at;
      const nextCrs = stanoxCrs[b.next_report_stanox];
      t.next = departed && nextCrs ? BY_CRS.get(nextCrs) || null : null;
      t.runMins = Number(b.next_report_run_time) || null;
      nat.log.push({ at, crs: stn.crs, name: stn.name, lat: stn.lat, lon: stn.lon, code: t.code, id: t.id, toc: t.toc, event: t.event, delay: t.delay, dest: t.destName || null });
      if (nat.log.length > LOG_MAX) nat.log.splice(0, nat.log.length - LOG_MAX);
    }
    changed = true;
  }
  return changed;
}

export function positionOf(t, now = Date.now()) {
  if (!t.at) return null;
  if (!t.next || !t.runMins) return { lat: t.at.lat, lon: t.at.lon };
  const f = Math.max(0, Math.min(0.9, (now - t.eventAt) / (t.runMins * 60000)));
  return { lat: t.at.lat + (t.next.lat - t.at.lat) * f, lon: t.at.lon + (t.next.lon - t.at.lon) * f };
}

export function trainsIn(nat, box, now = Date.now()) {
  const out = [];
  for (const t of nat.trains.values()) {
    if (t.terminated && now - t.updated > 10 * 60000) continue;
    const p = positionOf(t, now);
    if (!p || !inBox(p.lat, p.lon, box)) continue;
    out.push({ id: t.id, code: t.code, toc: t.toc, delay: t.delay, cancelled: !!t.cancelled, band: band(t), lat: p.lat, lon: p.lon, last: t.at.name, lastCrs: t.at.crs, nextCrs: t.next ? t.next.crs : null, lastEvent: t.event, lastAt: t.eventAt, next: t.next ? t.next.name : null, origin: t.originName || null, dest: t.destName || null });
  }
  // When zoomed far out, show the most delayed trains first
  out.sort((a, b) => (b.delay ?? 0) - (a.delay ?? 0));
  return { mode: 'live', total: out.length, trains: out.slice(0, 600) };
}

// When the timetable finishes loading, link the trains already being tracked
export function attachAll(nat) {
  for (const t of nat.trains.values()) { t.sched = null; attach(nat, t); }
}

export function detailOf(nat, id) {
  const t = nat.trains.get(id);
  if (!t) return { error: 'This train is no longer being tracked.' };
  const d = nat.tt && nat.tt.loadedAt ? trainDetail(nat.tt, t) : trainDetail({ tiplocs: new Map() }, { ...t, sched: null });
  d.mode = 'live';
  if (!d.matched && t.at) d.nextReport = t.next ? t.next.name : null;
  if (nat.tt && !nat.tt.loadedAt) d.note = 'The timetable is still loading, so stops will appear shortly.';
  return d;
}

// The same, with the stops ahead replaced by National Rail's live data when
// the Staff Version key is set: cancelled stops, platform changes, passing points.
export async function liveDetailOf(nat, id, getBoard = staffBoard) {
  const d = detailOf(nat, id);
  if (d.error || !staffEnabled()) return d;
  const t = nat.trains.get(id);
  // Ask the board at the next station (or the last one, if it hasn't moved on)
  const candidates = [];
  if (d.next && d.next.crs) candidates.push(d.next.crs);
  if (t.next && t.next.crs) candidates.push(t.next.crs);
  if (t.at && t.at.crs) candidates.push(t.at.crs);
  for (const crs of [...new Set(candidates)]) {
    let board;
    try { board = await getBoard(crs); } catch { continue; }
    if (!board || board.error) continue;
    const svc = findService(board, { uid: t.uid, headcode: t.code });
    if (!svc) continue;
    const st = BY_CRS.get(crs) || { name: board.locationName || crs, crs };
    const live = serviceToLive(svc, st);
    // Passing points come with short codes (e.g. COLTONJ); use the timetable's place names
    if (nat.tt) for (const s of live.stops) {
      if (s.tiploc && (s.name === s.tiploc || /^[A-Z0-9 ]+$/.test(s.name)) && nat.tt.tiplocs.has(s.tiploc)) s.name = nameOfTiploc(nat.tt, s.tiploc);
    }
    return mergeLive(d, live);
  }
  d.liveNote = 'National Rail has no live calling points for this train (freight and some specials are not covered).';
  return d;
}

export function mergeLive(d, live) {
  const passed = d.stops.filter((s) => s.state === 'passed');
  const firstAhead = live.stops[0];
  const keep = passed.filter((s) => s.name !== firstAhead.name);
  const ahead = live.stops.map((s) => ({
    ...s, state: s.actual ? 'passed' : 'due',
    expected: s.cancelled ? null : s.expected
  }));
  const stops = [...keep, ...ahead];
  const next = ahead.find((s) => s.state === 'due' && !s.pass && !s.cancelled) || null;
  return {
    ...d, stops, next, source: 'darwin',
    origin: d.origin || live.origin, dest: live.dest || d.dest,
    operator: d.operator || live.operator, cancelled: d.cancelled || live.cancelled,
    cancelReason: live.cancelReason, delayReason: live.delayReason, length: live.length,
    matched: true
  };
}

export function movesNear(nat, lat, lon, radius = 15, now = Date.now()) {
  const out = [];
  for (let i = nat.log.length - 1; i >= 0 && out.length < 80; i--) {
    const m = nat.log[i];
    if (now - m.at > 60 * 60000) continue;
    if (km(lat, lon, m.lat, m.lon) <= radius) out.push(m);
  }
  return { mode: 'live', moves: out };
}

export function pruneNational(nat, now = Date.now()) {
  for (const [id, t] of nat.trains) {
    if (now - (t.updated || 0) > 3 * 60 * 60000 || (t.terminated && now - t.updated > 15 * 60000)) nat.trains.delete(id);
  }
}
