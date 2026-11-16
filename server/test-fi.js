// Finland: Fintraffic GPS positions, live timetable and boards (sample data in Fintraffic's own format)
import assert from 'node:assert/strict';
import { createFinland, setStations, applyTrains, applyGps, finnishTrainsIn, boardFrom, detailFrom, appCode } from './fi.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const now = Date.now();
const iso = (mins) => new Date(now + mins * 60000).toISOString().replace(/\.\d+Z$/, '.000Z');
const fin = (mins) => new Date(now + mins * 60000).toLocaleTimeString('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const date = new Date(now - 30 * 60000).toLocaleDateString('en-CA', { timeZone: 'Europe/Helsinki' });

const fi = createFinland();
setStations(fi, [
  { passengerTraffic: true, type: 'STATION', stationName: 'Helsinki asema', stationShortCode: 'HKI', stationUICCode: 1, countryCode: 'FI', longitude: 24.941249, latitude: 60.172097 },
  { passengerTraffic: true, type: 'STATION', stationName: 'Pasila asema', stationShortCode: 'PSL', stationUICCode: 10, countryCode: 'FI', longitude: 24.933521, latitude: 60.198689 },
  { passengerTraffic: false, type: 'TURNOUT_IN_THE_OPEN_LINE', stationName: 'Ilmala', stationShortCode: 'ILR', stationUICCode: 9, countryCode: 'FI', longitude: 24.92, latitude: 60.21 },
  { passengerTraffic: true, type: 'STATION', stationName: 'Tampere asema', stationShortCode: 'TPE', stationUICCode: 160, countryCode: 'FI', longitude: 23.773, latitude: 61.498 },
  { passengerTraffic: true, type: 'STATION', stationName: 'Ylöjärvi', stationShortCode: 'YLÖ', stationUICCode: 700, countryCode: 'FI', longitude: 23.6, latitude: 61.55 }
]);
const row = (st, type, mins, extra = {}) => ({ trainStopping: true, stationShortCode: st, stationUICCode: 1, countryCode: 'FI', type, commercialStop: true, commercialTrack: '7', cancelled: false, scheduledTime: iso(mins), causes: [], ...extra });
// IC 45: left Helsinki 3 late, passed Ilmala, called at Pasila 4 late; Tampere ahead with traffic control's estimate
const ic45 = { trainNumber: 45, departureDate: date, operatorUICCode: 10, operatorShortCode: 'vr', trainType: 'IC', trainCategory: 'Long-distance', commuterLineID: '', runningCurrently: true, cancelled: false, version: 900, timetableType: 'REGULAR',
  timeTableRows: [
    row('HKI', 'DEPARTURE', -20, { actualTime: iso(-17), differenceInMinutes: 3 }),
    row('PSL', 'ARRIVAL', -15, { actualTime: iso(-11), differenceInMinutes: 4 }),
    row('PSL', 'DEPARTURE', -14, { actualTime: iso(-10), differenceInMinutes: 4 }),
    row('ILR', 'ARRIVAL', -12, { trainStopping: false, commercialStop: undefined, commercialTrack: '', actualTime: iso(-8), differenceInMinutes: 4 }),
    row('ILR', 'DEPARTURE', -12, { trainStopping: false, commercialStop: undefined, commercialTrack: '', actualTime: iso(-8), differenceInMinutes: 4 }),
    row('TPE', 'ARRIVAL', 60, { liveEstimateTime: iso(65), differenceInMinutes: 5, estimateSource: 'LIIKE_AUTOMATIC' })
  ] };
// R 9999: not started yet (no live times)
const r9 = { ...ic45, trainNumber: 9999, trainType: 'HL', trainCategory: 'Commuter', commuterLineID: 'R', runningCurrently: false, version: 950,
  timeTableRows: [row('HKI', 'DEPARTURE', 30), row('TPE', 'ARRIVAL', 120)] };

test('station codes: Finnish code with FI in front, Ä/Ö spelt out, "asema" dropped, freight-only points left off the map', () => {
  assert.equal(fi.stations.get('FIHKI').name, 'Helsinki');
  assert.equal(appCode('YLÖ'), 'FIYLOE');
  assert.ok(fi.stations.has('FIYLOE'));
  assert.ok(!fi.stations.has('FIILR'));
  assert.equal(fi.stations.get('FIHKI').country, 'fi');
});

applyTrains(fi, [ic45, r9], now, true);

test('a train\'s lateness is what traffic control recorded at the last place it reached; none before it starts', () => {
  const s = fi.trains.get(`${date}:45`).sum;
  assert.equal(s.delay, 4);
  assert.equal(s.last, 'Ilmala');
  assert.equal(s.next, 'Tampere');
  assert.equal(s.label, 'IC 45');
  assert.equal(s.toc, 'VR');
  assert.equal(fi.trains.get(`${date}:9999`).sum.delay, null);
  assert.equal(fi.trains.get(`${date}:9999`).sum.label, 'R 9999');
  assert.equal(fi.version, 950);
});

test('only the all-trains poll moves the change number on', () => {
  applyTrains(fi, [{ ...r9, version: 5000 }], now);
  assert.equal(fi.version, 950);
});

test('the map shows trains by their own GPS, and drops a fix older than 3 minutes', () => {
  applyGps(fi, [
    { trainNumber: 45, departureDate: date, timestamp: iso(-0.1), location: { type: 'Point', coordinates: [24.9, 60.25] }, speed: 120, accuracy: 5 },
    { trainNumber: 77, departureDate: date, timestamp: iso(-10), location: { type: 'Point', coordinates: [24.95, 60.3] }, speed: 0 }
  ], now);
  const t = finnishTrainsIn(fi, { w: 19, s: 59, e: 32, n: 70 }, now);
  assert.equal(t.length, 1);
  assert.equal(t[0].id, `fi:${date}:45`);
  assert.equal(t[0].lat, 60.25); assert.equal(t[0].lon, 24.9);
  assert.equal(t[0].delay, 4);
  assert.equal(t[0].country, 'fi');
  assert.equal(finnishTrainsIn(fi, { w: -8, s: 49, e: 2, n: 61 }, now).length, 0);
});

test('departure board: Finnish time and platform; "On time" only with a live time; nothing live means no claim', () => {
  const b = boardFrom(fi, 'FIHKI', 'dep', [ic45, r9], now);
  assert.equal(b.services.length, 1); // IC 45 left 17 minutes ago: boards keep trains 10 minutes after they go
  const r = b.services.find((s) => s.headcode === 'R 9999');
  assert.equal(r.booked, fin(30)); assert.equal(r.expected, null); assert.equal(r.noLive, true); assert.equal(r.platform, '7');
  assert.equal(r.place, 'Tampere');
});

test('arrival board: live estimate shown when late, with how late', () => {
  const b = boardFrom(fi, 'FITPE', 'arr', [ic45, r9], now);
  const ic = b.services.find((s) => s.headcode === 'IC 45');
  assert.equal(ic.booked, fin(60)); assert.equal(ic.expected, fin(65)); assert.equal(ic.delay, 5); assert.equal(ic.place, 'Helsinki');
  assert.equal(b.services.find((s) => s.headcode === 'R 9999').expected, null);
});

test('train page: stops with booked/actual/expected, passing points marked, GPS and source in the note', () => {
  const d = detailFrom(fi, ic45, fi.gps.get(`${date}:45`), now);
  assert.equal(d.stops.length, 4);
  const [hki, psl, ilr, tpe] = d.stops;
  assert.equal(hki.actual, fin(-17)); assert.equal(hki.state, 'passed'); assert.equal(hki.crs, 'FIHKI');
  assert.equal(psl.booked, fin(-15)); assert.equal(psl.actual, fin(-11)); assert.equal(psl.depActual, fin(-10)); assert.equal(psl.late, 4);
  assert.equal(ilr.pass, true); assert.equal(ilr.crs, null);
  assert.equal(tpe.state, 'due'); assert.equal(tpe.expected, fin(65)); assert.equal(tpe.late, 5);
  assert.equal(d.next.name, 'Tampere');
  assert.equal(d.delay, 4);
  assert.ok(d.gps && d.gps.speed === 120);
  assert.match(d.liveNote, /own GPS/);
  const noGps = detailFrom(fi, r9, null, now);
  assert.match(noGps.liveNote, /isn't on the map/);
  assert.equal(noGps.stops[0].late, null);
});

test('unknown delay: traffic control says delayed but not by how much', () => {
  const t = { ...r9, timeTableRows: [row('HKI', 'DEPARTURE', 30, { unknownDelay: true }), row('TPE', 'ARRIVAL', 120)] };
  assert.equal(boardFrom(fi, 'FIHKI', 'dep', [t], now).services[0].expected, 'Delayed');
  assert.match(detailFrom(fi, t, null, now).delayReason, /can't yet say/);
});

console.log(`Finland: ${passed} passed`);
