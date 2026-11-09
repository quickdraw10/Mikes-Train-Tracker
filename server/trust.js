// Train movements (TRUST) feed: when each train passes or calls at a
// timing point, and how late it is. A batch is an array of
//   { header: { msg_type }, body: {...} }
//   0001 activation, 0002 cancellation, 0003 movement, 0005 reinstatement
// The 10-character train_id holds the headcode in characters 3–6
// (e.g. "721J24MW08" -> "1J24"), which is how we join it to the TD feed.

import { ROUTES } from '../app/layout.js';
import { train } from '../app/model.js';

const TOCS = { '84': 'South Western Railway', '88': 'GTR' };

export function headcodeOf(trainId) {
  return (trainId || '').slice(2, 6);
}

// TRUST timestamps are reported one hour ahead during British Summer Time
// (per the Open Rail Data wiki), so take that hour back off.
const londonParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' });
export function trustTime(ms) {
  const t = Number(ms);
  if (!t) return null;
  const inBst = /GMT\+1/.test(londonParts.format(new Date(t - 3600000)));
  return inBst ? t - 3600000 : t;
}

export function delayOf(body) {
  const v = Number(body.timetable_variation) || 0;
  if (body.variation_status === 'LATE') return v;
  if (body.variation_status === 'EARLY') return -v;
  return 0;
}

// stanoxIndex: Map stanox -> [{ routeId, index }]
export function buildStanoxIndex() {
  const idx = new Map();
  for (const r of ROUTES) {
    r.stations.forEach((s, i) => {
      for (const sx of [].concat(s.stanox || [])) {
        if (!idx.has(sx)) idx.set(sx, []);
        idx.get(sx).push({ routeId: r.id, index: i });
      }
    });
  }
  return idx;
}

export function handleTrust(batch, raw, stanoxIndex, now = Date.now()) {
  let changed = false;
  for (const msg of batch) {
    const type = msg.header && msg.header.msg_type;
    const b = msg.body || {};
    const code = headcodeOf(b.train_id);
    if (!code) continue;

    if (type === '0002') {
      if (raw.trains[code]) { raw.trains[code].cancelled = true; changed = true; }
      continue;
    }
    if (type === '0007') {
      // Change of identity: the train now runs under a new headcode
      const next = headcodeOf(b.revised_train_id);
      const t = raw.trains[code];
      // only for the very train we have pinned, never just a train sharing the headcode
      if (t && t.trainId === b.train_id && next && next !== code) {
        raw.trains[next] = { ...t, code: next, trainId: b.revised_train_id };
        delete raw.trains[code];
        for (const [k, v] of Object.entries(raw.berths)) if (v === code) raw.berths[k] = next;
        changed = true;
      }
      continue;
    }
    if (type === '0005') {
      if (raw.trains[code]) { raw.trains[code].cancelled = false; changed = true; }
      continue;
    }
    if (type !== '0003') continue;

    const hits = stanoxIndex.get(b.loc_stanox);
    const t = raw.trains[code];
    // Only route stations here. Panel trains get their delay from the national
    // tracker, matched by headcode AND place (linkPanelTrains in national.js), because
    // the same headcode can be running elsewhere in the country at the same time.
    if (!hits) continue;
    if (t && t.trainId && t.trainId !== b.train_id) continue;
    const tr = t || train(raw, code);
    tr.delay = delayOf(b);
    tr.trainId = b.train_id;
    if (b.toc_id) tr.toc = TOCS[b.toc_id] || 'Operator ' + b.toc_id;
    tr.terminated = b.train_terminated === 'true';
    tr.seen = now;

    for (const { routeId, index } of hits || []) {
      const r = ROUTES.find((x) => x.id === routeId);
      const prev = tr.routes[routeId];
      let dir;
      if (prev && Math.round(prev.pos) !== index) dir = index > prev.pos ? 'down' : 'up';
      else if (prev) dir = prev.dir;
      else dir = b.direction_ind === 'UP' ? 'up' : 'down';
      const departing = b.event_type === 'DEPARTURE';
      let pos = index;
      if (departing) pos = dir === 'down' ? index + 0.5 : index - 0.5;
      pos = Math.max(0, Math.min(r.stations.length - 1, pos));
      tr.routes[routeId] = { pos, dir, at: now };
      tr.last = { name: r.stations[index].name, event: departing ? 'Departed' : 'Arrived', at: trustTime(b.actual_timestamp) || now };
      if (departing && pos % 1 !== 0) raw.sections[routeId + ':' + dir + ':' + Math.floor(pos)] = { delay: tr.delay, at: now };
      if (!tr.desc && r) tr.desc = r.name;
    }
    changed = true;
  }
  return changed;
}

// Forget trains we have not heard about for a long time (keeps memory flat)
export function prune(raw, now = Date.now(), maxAge = 3 * 60 * 60 * 1000) {
  const onBerth = new Set(Object.values(raw.berths));
  for (const [code, t] of Object.entries(raw.trains)) {
    if (!onBerth.has(code) && now - (t.seen || 0) > maxAge) delete raw.trains[code];
  }
  for (const [k, st] of Object.entries(raw.steps || {})) if (now - st.at > maxAge) delete raw.steps[k];
}
