// A station's platforms over the next two hours: which train is in which platform, and when.
// From National Rail's live boards (Darwin): the staff departures board for trains calling or
// starting here (with arrival and departure times and platforms, including ones not shown to the
// public), and the arrivals board for trains ending here.
//
// Each train uses its actual time if it has one, else Darwin's expected time, else the booked time,
// and says which. Where only one end is known (a train starting or ending here), only that end is
// drawn: we don't guess how long it sits in the platform.

import { staffBoard, hm } from './staff.js';

const ARR_BASE = process.env.LDB_ARR_BASE || 'https://api1.raildata.org.uk/1010-live-arrival-board-arr/LDBWS/api/20220120';
const names = (list) => (list || []).map((l) => l.locationName).join(' & ');
const crsOf = (list) => ((list || [])[0] || {}).crs || null;

// "17:34" + "On time" / "17:41" / "Delayed" / "Cancelled", or an actual -> { time, kind }
function timeOf(booked, expected, actual) {
  const b = hm(booked), a = hm(actual), e = hm(expected);
  if (a) return { time: a, kind: 'actual', booked: b };
  if (e && /\d/.test(e)) return { time: e, kind: 'expected', booked: b };
  if (/on time/i.test(expected || '') && b) return { time: b, kind: 'expected', booked: b };
  if (b) return { time: b, kind: /delayed/i.test(expected || '') ? 'delayed' : 'booked', booked: b };
  return null;
}

export async function platformsAt(crs) {
  const dep = await staffBoard(crs);
  if (!dep || dep.error) return { error: (dep && dep.error) || 'National Rail did not answer' };
  const trains = [];
  for (const s of dep.trainServices || []) {
    trains.push({
      id: s.rid || s.uid, headcode: s.trainid || s.trainId || null, operator: s.operator || null,
      platform: s.platform || null, platformHidden: Boolean(s.platformIsHidden),
      from: names(s.origin), to: names(s.destination), startsHere: crsOf(s.origin) === crs,
      arr: s.sta ? timeOf(s.sta, s.eta, s.ata) : null, dep: timeOf(s.std, s.etd, s.atd),
      cancelled: Boolean(s.isCancelled), passenger: s.isPassengerService !== false
    });
  }
  // trains ending here aren't on a departures board: take them from the arrivals board
  const key = process.env.LDB_ARR_KEY || process.env.LDB_KEY;
  if (key) {
    try {
      const res = await fetch(`${ARR_BASE}/GetArrBoardWithDetails/${encodeURIComponent(crs)}?numRows=40&timeWindow=120`, { headers: { 'x-apikey': key }, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const a = await res.json();
        for (const s of a.trainServices || []) {
          if (crsOf(s.destination) !== crs) continue; // calling trains are already on the departures board
          trains.push({
            id: s.serviceID || s.rsid, headcode: null, operator: s.operator || null, platform: s.platform || null, platformHidden: false,
            from: names(s.origin), to: names(s.destination), endsHere: true,
            arr: timeOf(s.sta, s.eta, null), dep: null, cancelled: Boolean(s.isCancelled), passenger: true
          });
        }
      }
    } catch { /* arrivals are a bonus: the departures still make a platform view */ }
  }
  const platforms = [...new Set(trains.map((t) => t.platform).filter(Boolean))]
    .sort((x, y) => (parseInt(x, 10) || 999) - (parseInt(y, 10) || 999) || x.localeCompare(y));
  return { mode: 'live', crs, name: dep.locationName || crs, platforms, trains, unplatformed: trains.filter((t) => !t.platform).length, credit: 'Live platforms and times: National Rail (Darwin)' };
}
