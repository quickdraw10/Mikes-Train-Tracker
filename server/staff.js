// National Rail live train data (Darwin) through "Live Departure Board - Staff
// Version" on the Rail Data Marketplace. Key in LDB_STAFF_KEY.
//
// The subscription gives GetDepBoardWithDetails/{crs}/{time}: every train due
// to leave a station, each with its remaining calling points and passing points,
// live estimates, actual times, platforms (including hidden ones), cancellations,
// reasons and train length. The train screen asks for the board at the train's
// next station and picks the train out by its UID or headcode.
//
// Field names are read defensively because this API isn't documented here:
// /api/staff-debug/:crs shows the raw reply so the parsing can be checked.

const BASE = process.env.LDB_STAFF_BASE || 'https://api1.raildata.org.uk/1010-live-departure-board---staff-version1_0/LDBSVWS/api/20220120';
const cache = new Map();

export const staffEnabled = () => Boolean(process.env.LDB_STAFF_KEY);

// London wall-clock time as yyyyMMddTHHmmss
export function staffTime(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

// "2026-11-09T14:52:00" or "14:52" or "On time"/"Delayed"/"Cancelled" -> "HH:MM" or the word
export function hm(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const iso = /T(\d\d):(\d\d)/.exec(s);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const plain = /^(\d\d):(\d\d)/.exec(s);
  if (plain) return `${plain[1]}:${plain[2]}`;
  return s;
}

export async function staffBoard(crs, { now = Date.now(), raw = false } = {}) {
  const key = process.env.LDB_STAFF_KEY;
  if (!key) return { error: 'No LDB_STAFF_KEY set' };
  const ck = crs;
  const hit = cache.get(ck);
  if (!raw && hit && now - hit.at < 45000) return hit.data;
  // Start a little in the past so late-running trains due earlier are included
  const url = `${BASE}/GetDepBoardWithDetails/${encodeURIComponent(crs)}/${staffTime(now - 10 * 60000)}?numRows=60&timeWindow=120`;
  const res = await fetch(url, { headers: { 'x-apikey': key }, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  if (!res.ok) return { error: `National Rail (staff) returned ${res.status}`, body: text.slice(0, 500) };
  const data = JSON.parse(text);
  if (raw) return data;
  cache.set(ck, { at: now, data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// The remaining locations of one service, whatever the reply calls them
function locationsOf(svc) {
  if (svc.subsequentLocations) return list(svc.subsequentLocations);
  const cp = svc.subsequentCallingPoints;
  if (cp) return list(cp).flatMap((g) => list(g.callingPoint || g));
  return [];
}

export function findService(board, { uid, headcode }) {
  const services = list(board && board.trainServices);
  return services.find((s) => uid && s.uid === uid)
    || services.find((s) => headcode && (s.trainid === headcode || s.trainId === headcode || s.headcode === headcode))
    || null;
}

const names = (l) => list(l).map((x) => x.locationName).filter(Boolean).join(' & ') || null;

// Turn one Darwin service into the train screen's shape for the stops ahead
export function serviceToLive(svc, boardStation) {
  const here = {
    name: boardStation.name, crs: boardStation.crs,
    booked: hm(svc.std || svc.sta), expected: hm(svc.etd || svc.eta), actual: hm(svc.atd || svc.ata),
    platform: svc.platformIsHidden ? null : svc.platform || null, hiddenPlatform: svc.platformIsHidden ? svc.platform || null : null,
    cancelled: Boolean(svc.isCancelled), pass: false
  };
  const ahead = locationsOf(svc).map((l) => ({
    name: l.locationName || l.tiploc, crs: l.crs || null,
    booked: hm(l.std || l.sta || l.st), expected: hm(l.etd || l.eta || l.et), actual: hm(l.atd || l.ata || l.at),
    working: hm(l.wtd || l.wta || l.wtp),
    platform: l.platformIsHidden ? null : l.platform || null, hiddenPlatform: l.platformIsHidden ? l.platform || null : null,
    cancelled: Boolean(l.isCancelled), pass: Boolean(l.isPass), operational: Boolean(l.isOperational)
  })).filter((s) => !s.operational || s.pass);
  return {
    source: 'darwin',
    rid: svc.rid || null, uid: svc.uid || null, headcode: svc.trainid || svc.trainId || null,
    operator: svc.operator || null, length: Number(svc.length) || null,
    cancelled: Boolean(svc.isCancelled), cancelReason: textOf(svc.cancelReason), delayReason: textOf(svc.delayReason),
    origin: names(svc.origin), dest: names(svc.destination),
    stops: [here, ...ahead]
  };
}

function textOf(r) {
  if (!r) return null;
  if (typeof r === 'string') return r;
  return r.value || r.Value || r.reason || null;
}
