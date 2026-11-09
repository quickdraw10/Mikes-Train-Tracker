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
    booked: hm(svc.std || svc.sta),
    expected: svc.std ? expectedOf(svc.etd, svc.departureType, hm(svc.std)) : expectedOf(svc.eta, svc.arrivalType, hm(svc.sta)),
    actual: hm(svc.atd) || null,
    platform: svc.platformIsHidden ? null : svc.platform || null, hiddenPlatform: svc.platformIsHidden ? svc.platform || null : null,
    cancelled: Boolean(svc.isCancelled), pass: false
  };
  const ahead = locationsOf(svc).map((l) => ({
    name: l.locationName || l.tiploc, tiploc: l.tiploc || null, crs: l.crs || null,
    booked: hm(l.sta || l.std || l.st),
    expected: l.sta ? expectedOf(l.eta, l.arrivalType, hm(l.sta)) : expectedOf(l.etd || l.et, l.departureType, hm(l.std || l.st)),
    actual: hm(l.ata || l.atd || l.at),
    working: hm(l.wtd || l.wta || l.wtp),
    platform: l.platformIsHidden ? null : l.platform || null, hiddenPlatform: l.platformIsHidden ? l.platform || null : null,
    cancelled: Boolean(l.isCancelled), pass: Boolean(l.isPass), operational: Boolean(l.isOperational)
  })).filter((s) => !s.operational || s.pass);
  return {
    source: 'darwin',
    rid: svc.rid || null, uid: svc.uid || null, headcode: svc.trainid || svc.trainId || null,
    operator: svc.operator || null, operatorCode: svc.operatorCode || null, length: Number(svc.length) || null,
    cancelled: Boolean(svc.isCancelled), cancelReason: textOf(svc.cancelReason, 'canc'), delayReason: textOf(svc.delayReason, 'late'),
    origin: names(svc.origin), dest: names(svc.destination),
    stops: [here, ...ahead]
  };
}

// The Staff Version gives reasons as Darwin reason codes (e.g. 871), not text.
// The meanings come from Darwin's own reason code list (GetReasonCodeList), fetched
// once a day. We never make up a meaning: if the list can't be fetched, the code is
// shown on its own.
const REASONS = new Map(); // code -> { late, canc }
let reasonsInfo = { loaded: false, tried: [] };
const STAFF_ROOT = BASE.replace(/\/LDBSVWS\/.*$/, '');
const REF_URLS = () => [
  process.env.LDB_REF_URL,
  // the Staff Version has its own GetReasonCodeList alongside the boards (see its swagger)
  `${BASE}/GetReasonCodeList`,
  `${STAFF_ROOT}/LDBSVWS/api/ref/20211101/GetReasonCodeList`,
  'https://api1.raildata.org.uk/1010-reference-data1_0/LDBSVWS/api/ref/20211101/GetReasonCodeList'
].filter(Boolean);

export async function loadReasons() {
  const key = process.env.LDB_REF_KEY || process.env.LDB_STAFF_KEY;
  if (!key) return reasonsInfo;
  const tried = [];
  for (const url of REF_URLS()) {
    try {
      const res = await fetch(url, { headers: { 'x-apikey': key }, signal: AbortSignal.timeout(10000) });
      tried.push({ url, status: res.status });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.reasons || data.GetReasonCodeListResult || data.reason || [];
      for (const r of list) {
        const code = String(r.code ?? r.Code ?? '').trim();
        if (code) REASONS.set(code, { late: r.lateReason || r.LateReason || null, canc: r.cancReason || r.CancReason || null });
      }
      if (REASONS.size) { reasonsInfo = { loaded: true, count: REASONS.size, url, at: new Date().toISOString(), tried }; return reasonsInfo; }
    } catch (e) { tried.push({ url, error: e.message }); }
  }
  reasonsInfo = { loaded: false, tried };
  return reasonsInfo;
}
export const reasonsStatus = () => reasonsInfo;
export const reasonMap = REASONS;

// Code plus meaning: "This train has been delayed by … (code 871)", or just the code
export function textOf(r, kind = 'late') {
  if (r == null || r === '') return null;
  const v = typeof r === 'object' ? (r.value ?? r.Value ?? r.reason ?? r.code ?? null) : r;
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const m = REASONS.get(s);
    const text = m && (kind === 'canc' ? m.canc || m.late : m.late || m.canc);
    return text ? `${text} (code ${s})` : `Reason code ${s}`;
  }
  return s;
}

// Expected time: the estimate if there is one, else Darwin's "Delayed" flag, else the booked time
export function expectedOf(est, type, booked) {
  if (est) return hm(est);
  if (type === 'Delayed') return 'Delayed';
  return booked;
}
