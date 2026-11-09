// Train Describer (TD) feed: which berth each train's headcode is in.
// A batch is an array of objects keyed by type (Open Rail Data wiki, C-Class Messages):
//   CA_MSG  berth step       { area_id, from, to, descr, time }  from is cleared, to is overwritten
//   CB_MSG  berth cancel     { area_id, from, descr, time }      from is cleared
//   CC_MSG  berth interpose  { area_id, to, descr, time }        to is overwritten
//   CT_MSG  heartbeat        { area_id, report_time, time }      the area is alive
// S-class messages (signal states) are ignored for now.

import { train } from '../app/model.js';

export function handleTd(batch, raw, areas, now = Date.now()) {
  let changed = false;
  raw.areaSeen ||= {};
  for (const item of batch) {
    const [type, m] = Object.entries(item)[0] || [];
    if (!m || !areas.has(m.area_id)) continue;
    const a = m.area_id;
    // Any message, heartbeats included, shows the area is still reporting.
    // Our own clock is used: TD dates events by the day they arrive, so
    // messages sent just before midnight can be stamped a day out.
    raw.areaSeen[a] = now;
    const descr = (m.descr || '').trim();
    if (type === 'CA_MSG') {
      delete raw.berths[a + ':' + m.from];
      raw.berths[a + ':' + m.to] = descr;
      // The last step each train made, so the panel can tell approaching from just gone
      (raw.steps ||= {})[a + ':' + descr] = { from: a + ':' + m.from, to: a + ':' + m.to, at: now };
    } else if (type === 'CB_MSG') {
      delete raw.berths[a + ':' + m.from];
    } else if (type === 'CC_MSG') {
      raw.berths[a + ':' + m.to] = descr;
    } else {
      continue;
    }
    if (descr && type !== 'CB_MSG') train(raw, descr).seen = now;
    changed = true;
  }
  return changed;
}
