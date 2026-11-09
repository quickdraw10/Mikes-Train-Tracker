// Station departure and arrival boards from National Rail's Live Departure
// Boards, through the Rail Data Marketplace (raildata.org.uk). Free; each
// product you subscribe to there gives a "Consumer key":
//   LDB_KEY      "Live Departure Board" product            -> departures
//   LDB_ARR_KEY  "Live Arrival Board" product                -> arrivals
//                (falls back to LDB_KEY if not set)
// Boards are cached for 30 seconds so many phones don't multiply requests.

import { staffBoard, staffEnabled, hm } from './staff.js';

const DEP_BASE = process.env.LDB_DEP_BASE || 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120';
const ARR_BASE = process.env.LDB_ARR_BASE || 'https://api1.raildata.org.uk/1010-live-arrival-board-arr/LDBWS/api/20220120';
const cache = new Map();

function minutes(hhmm) {
  const m = /^(\d\d):(\d\d)$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function delayBetween(booked, expected) {
  const a = minutes(booked), b = minutes(expected);
  if (expected === 'On time') return 0;
  if (a == null || b == null) return null;
  let d = b - a;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

const names = (list) => (list || []).map((l) => l.locationName + (l.via ? ' ' + l.via : '')).join(' & ');

export function normalise(data, type) {
  const services = (data.trainServices || [])
    .filter((s) => (type === 'arr' ? s.sta : s.std))
    .map((s) => {
      const booked = type === 'arr' ? s.sta : s.std;
      const expected = type === 'arr' ? s.eta : s.etd;
      const cancelled = Boolean(s.isCancelled) || expected === 'Cancelled';
      return {
        id: s.serviceID || booked + names(s.destination),
        booked, expected, cancelled,
        delay: cancelled ? null : delayBetween(booked, expected),
        place: type === 'arr' ? names(s.origin) : names(s.destination),
        platform: s.platform || null,
        toc: s.operator || null,
        reason: s.cancelReason || s.delayReason || null
      };
    });
  return { mode: 'live', crs: data.crs, name: data.locationName, type, services, messages: (data.nrccMessages || []).map((m) => (m.Value || m.value || '').replace(/<[^>]+>/g, '')).filter(Boolean) };
}

// Departures from the Staff Version (the main source): adds headcodes, hidden
// platforms and non-passenger trains. Falls back to the public board on any problem.
export function normaliseStaff(data) {
  const services = (data.trainServices || []).filter((s) => s.std).map((s) => {
    const booked = hm(s.std);
    const expected = s.atd ? hm(s.atd) : hm(s.etd);
    const cancelled = Boolean(s.isCancelled);
    return {
      id: s.rid || s.uid || booked + names(s.destination), headcode: s.trainid || s.trainId || null,
      booked, expected: cancelled ? 'Cancelled' : expected === booked ? 'On time' : expected, cancelled,
      departed: Boolean(s.atd),
      delay: cancelled ? null : expected && /\d/.test(expected) ? delayBetween(booked, expected) : expected === 'On time' ? 0 : null,
      place: names(s.destination) || '—', platform: s.platform || null, platformHidden: Boolean(s.platformIsHidden),
      toc: s.operator || null, passenger: s.isPassengerService !== false,
      reason: textOf(s.cancelReason) || textOf(s.delayReason) || null,
      length: Number(s.length) || null
    };
  });
  return { mode: 'live', source: 'staff', crs: data.crs, name: data.locationName, type: 'dep', services, messages: [] };
}
const textOf = (r) => (!r ? null : typeof r === 'string' ? r : r.value || r.Value || null);

export async function getBoard(crs, type = 'dep') {
  if (type === 'dep' && staffEnabled()) {
    try {
      const b = await staffBoard(crs);
      if (b && !b.error) return normaliseStaff(b);
    } catch { /* fall back to the public board */ }
  }
  const key = type === 'arr' ? process.env.LDB_ARR_KEY || process.env.LDB_KEY : process.env.LDB_KEY;
  if (!key) return { error: 'Station boards need a free National Rail key from raildata.org.uk (see README).', needsKey: true };
  const ck = type + ':' + crs;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  const url = type === 'arr'
    ? `${ARR_BASE}/GetArrBoardWithDetails/${encodeURIComponent(crs)}?numRows=15`
    : `${DEP_BASE}/GetDepartureBoard/${encodeURIComponent(crs)}?numRows=15`;
  const res = await fetch(url, { headers: { 'x-apikey': key }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { error: `National Rail returned ${res.status}. Check the key is subscribed to the right product.` };
  const data = normalise(await res.json(), type);
  cache.set(ck, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}
