// Every train in the country, from the movements (TRUST) feed, for the map.
// A train is placed at the last station it reported from. Once it has departed
// it is moved along towards its next reporting point using the feed's own
// running-time estimate, so it creeps along the line between reports.
// Timing points that are not stations (junctions, sidings) have no map position:
// the train keeps its last station position but its delay still updates.

import { BY_CRS, km, inBox } from '../app/geo.js';
import { band } from '../app/model.js';
import { headcodeOf, delayOf, trustTime } from './trust.js';

const TOCS = { '84': 'South Western Railway', '88': 'GTR' };
const LOG_MAX = 20000;

export function createNational() {
  return { trains: new Map(), log: [] };
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
    if (type !== '0003') continue;

    let t = nat.trains.get(id);
    if (!t) { t = { id, code: headcodeOf(id), toc: null, delay: null }; nat.trains.set(id, t); }
    t.delay = delayOf(b);
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
      nat.log.push({ at, crs: stn.crs, name: stn.name, lat: stn.lat, lon: stn.lon, code: t.code, toc: t.toc, event: t.event, delay: t.delay });
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
    out.push({ id: t.id, code: t.code, toc: t.toc, delay: t.delay, cancelled: !!t.cancelled, band: band(t), lat: p.lat, lon: p.lon, last: t.at.name, lastEvent: t.event, lastAt: t.eventAt, next: t.next ? t.next.name : null });
  }
  // When zoomed far out, show the most delayed trains first
  out.sort((a, b) => (b.delay ?? 0) - (a.delay ?? 0));
  return { mode: 'live', total: out.length, trains: out.slice(0, 600) };
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
