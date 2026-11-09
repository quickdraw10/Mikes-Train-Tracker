// Tests for timetable matching, the train screen data and the York panel builder.
import assert from 'node:assert/strict';
import { createTimetable, ingest, finish, matchByHeadcode, trainDetail, mins } from './timetable.js';
import { createNational, handleNational, detailOf, attachAll } from './national.js';
import { buildStationPanel } from './panelbuild.js';
import { findService, serviceToLive, staffTime, textOf, reasonMap } from './staff.js';
import { normaliseStaff } from './ldb.js';
import { mergeLive } from './national.js';
import { buildView } from '../app/model.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

const DATE = '2026-11-09'; // a Monday
const T = (date, hhmm) => Date.parse(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`); // TRUST style wall-clock
const tip = (code, stanox, crs, desc) => ({ TiplocV1: { transaction_type: 'Create', tiploc_code: code, stanox, crs_code: crs, description: desc, tps_description: desc } });
const loc = (type, tiploc, o) => ({ location_type: type, record_identity: type, tiploc_code: tiploc, ...o });
function sched(uid, stp, days, locs, extra = {}) {
  return { JsonScheduleV1: { CIF_train_uid: uid, CIF_stp_indicator: stp, schedule_start_date: '2026-05-17', schedule_end_date: '2026-12-12', schedule_days_runs: days,
    atoc_code: 'NT', transaction_type: 'Create', schedule_segment: { signalling_id: '1D14', CIF_train_category: 'OO', schedule_location: locs }, ...extra } };
}
const LOCS = [
  loc('LO', 'DONC', { departure: '1400', public_departure: '1400', platform: '3' }),
  loc('LI', 'ADWICK', { arrival: '1407', departure: '1408', public_arrival: '1407', public_departure: '1408' }),
  loc('LI', 'SKELTON', { pass: '1411H' }),
  loc('LI', 'WKFDKG', { arrival: '1432', departure: '1433', public_arrival: '1432', public_departure: '1433', platform: '1' }),
  loc('LT', 'LEEDS', { arrival: '1450', public_arrival: '1450', platform: '12' })
];

function timetable() {
  const tt = createTimetable();
  tt.dates = ['2026-11-08', DATE, '2026-11-10'];
  const pending = new Map();
  for (const r of [tip('DONC', '18000', 'DON', 'DONCASTER'), tip('ADWICK', '18001', 'AWK', 'ADWICK'), tip('SKELTON', '18002', null, 'SKELTON JN'),
    tip('WKFDKG', '18003', 'WKK', 'WAKEFIELD KIRKGATE'), tip('LEEDS', '18004', 'LDS', 'LEEDS'),
    sched('C12345', 'P', '1111100', LOCS),
    sched('C12345', 'O', '1000000', LOCS.map((l, i) => (i === 4 ? { ...l, platform: '15' } : l))), // Monday overlay: platform change
    sched('C99999', 'P', '1111111', LOCS), sched('C99999', 'C', '1000000', [])]) ingest(r, tt, pending);
  finish(tt, pending);
  return tt;
}

test('half-minute times are read correctly', () => {
  assert.equal(mins('1411H'), 851.5);
  assert.equal(mins(null), null);
});

test('overlays replace the permanent timetable and cancellations remove it, for that day only', () => {
  const tt = timetable();
  assert.equal(tt.byDate.get(DATE).get('C12345').stp, 'O');
  assert.equal(tt.byDate.get('2026-11-10').get('C12345').stp, 'P');
  assert.equal(tt.byDate.get(DATE).has('C99999'), false);
  assert.equal(tt.byDate.get('2026-11-10').has('C99999'), true);
  assert.equal(tt.tiplocs.get('DONC').name, 'Doncaster'); // station name from the station list
});

test('a train we did not see start is matched by headcode, place and time', () => {
  const tt = timetable();
  const m = matchByHeadcode(tt, '1D14', '18001', T(DATE, '1410'));
  assert.equal(m.s.uid, 'C12345');
  assert.equal(matchByHeadcode(tt, '1D14', '18001', T(DATE, '1800')), null); // too far from the timetable
});

test('live train gets origin, destination, operator, next stop with expected time, and stops', () => {
  const tt = timetable();
  const nat = createNational(tt);
  handleNational([{ header: { msg_type: '0001' }, body: { train_id: '181D14MW09', train_uid: 'C12345', origin_dep_timestamp: String(T(DATE, '1400')), sched_origin_stanox: '18000' } }], nat, {});
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '181D14MW09', loc_stanox: '18001', event_type: 'DEPARTURE', planned_timestamp: String(T(DATE, '1408')), actual_timestamp: String(T(DATE, '1413')), timetable_variation: '5', variation_status: 'LATE' } }], nat, {});
  const d = detailOf(nat, '181D14MW09');
  assert.equal(d.origin, 'Doncaster');
  assert.equal(d.dest, 'Leeds');
  assert.equal(d.operator, 'Northern');
  assert.equal(d.next.name, 'Wakefield Kirkgate');
  assert.equal(d.next.booked, '14:32');
  assert.equal(d.next.expected, '14:37');
  assert.deepEqual(d.stops.map((s) => s.name), ['Doncaster', 'Adwick', 'Wakefield Kirkgate', 'Leeds']); // passing points left out
  assert.equal(d.stops[1].state, 'passed');
  assert.equal(d.stops[3].platform, '15'); // Monday's overlay
});

test('trains already running when the timetable arrives are linked afterwards', () => {
  const tt = createTimetable();
  const nat = createNational(tt);
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '181D14MW09', loc_stanox: '18001', event_type: 'ARRIVAL', planned_timestamp: String(T(DATE, '1407')), timetable_variation: '0', variation_status: 'ON TIME' } }], nat, {});
  assert.equal(detailOf(nat, '181D14MW09').matched, false);
  Object.assign(tt, timetable());
  attachAll(nat);
  assert.equal(detailOf(nat, '181D14MW09').dest, 'Leeds');
});

test('York panel: one road per platform, approach berths on the correct side', () => {
  const R = (from, to, ev, plat, stanme = 'YORK') => ({ TD: 'Y1', FROMBERTH: from, TOBERTH: to, EVENT: ev, PLATFORM: plat, STANME: stanme, STEPTYPE: 'B' });
  const smart = { BERTHDATA: [
    R('0500', '0510', 'C', '5'), R('0510', '0520', 'D', '5'),   // down: arrive from south, leave north
    R('0530', '0511', 'A', '5'), R('0511', '0501', 'B', '5'),   // up: arrive from north, leave south
    R('0400', '0410', 'C', '10'), R('0410', '0420', 'D', '10'),
    R('0490', '0500', '', '', 'HOLGATE'),                         // a step further out, no platform
    R('0001', '0003', 'C', '1', 'SKELTON'), { ...R('0700', '0710', 'C', '3'), TD: 'Y2' }
  ] };
  const p = buildStationPanel(smart, { id: 'york', name: 'York', area: 'Y1', stanme: 'YORK', ends: ['S', 'N'] });
  assert.deepEqual(p.tracks.map((t) => t.name), ['5', '10']);
  const road5 = Object.fromEntries(p.tracks[0].berths.flatMap((b) => (b.keys || ['Y1:' + b.id]).map((k) => [k.split(':')[1], b])));
  assert.equal(road5['0510'].kind, 'platform');
  assert.ok(road5['0500'].col <= 4 && road5['0501'].col <= 4, 'south approaches on the left');
  assert.ok(road5['0520'].col >= 7 && road5['0530'].col >= 7, 'north approaches on the right');
  assert.equal(road5['0490'].col, 3, 'one step further out, from the stepping table');
});

test('a berth leading to two platforms is drawn once, with a switch to the other road', () => {
  const R = (from, to, ev, plat) => ({ TD: 'Y1', FROMBERTH: from, TOBERTH: to, EVENT: ev, PLATFORM: plat, STANME: 'YORK', STEPTYPE: 'B' });
  const smart = { BERTHDATA: [R('0100', '0110', 'C', '1'), R('0100', '0210', 'C', '2'), R('0100', '0310', 'C', '3'), R('0090', '0100', '', '')] };
  const p = buildStationPanel(smart, { id: 'y', name: 'Y', area: 'Y1', stanme: 'YORK', ends: ['S', 'N'] });
  const drawn = p.tracks.flatMap((t, i) => t.berths.filter((b) => b.id === '0100').map(() => i));
  assert.deepEqual(drawn, [1], 'on the middle road only');
  assert.ok(p.links.includes('1:4>0:5') && p.links.includes('1:4>2:5'), 'switches to roads 1 and 3');
  assert.equal(p.tracks[1].berths.find((b) => b.id === '0090').col, 3);
});

test('panel by STANOX: platforms split across two TD areas, berth numbers kept apart', () => {
  const R = (td, from, to, ev, plat, stanox = '87219') => ({ TD: td, FROMBERTH: from, TOBERTH: to, EVENT: ev, PLATFORM: plat, STANOX: stanox, STANME: 'CLPHMJN', STEPTYPE: 'B' });
  const smart = { BERTHDATA: [
    R('VC', '0100', '0110', 'C', '12'), R('VC', '0110', '0120', 'D', '12'), R('VC', '0130', '0111', 'A', '13'),
    R('WI', '0100', '0110', 'C', '3'), R('WI', '0110', '0120', 'D', '3'),
    R('WI', '0500', '0510', 'C', '1', '99999')                      // another station
  ] };
  const p = buildStationPanel(smart, { id: 'clj', name: 'Clapham Junction', stanox: ['87219'], ends: ['A', 'B'] });
  assert.deepEqual(p.areas, ['VC', 'WI']);
  assert.equal(p.area, 'VC');
  assert.deepEqual(p.tracks.map((t) => t.name), ['3', '12', '13']);
  const road3 = p.tracks[0].berths.find((b) => b.kind === 'platform');
  assert.equal(road3.id, '0110');
  assert.equal(road3.area, 'WI', 'a berth from the second area says which area it is in');
  assert.equal(p.tracks[1].berths.find((b) => b.kind === 'platform').area, undefined);
  // the panel reads each berth from its own area
  const raw = { berths: { 'WI:0110': '2C45', 'VC:0110': '1D22' }, trains: {}, sections: {}, mode: 'live', areaSeen: { WI: Date.now() } };
  const v = buildView(raw, Date.now(), [p]).panels[0];
  assert.equal(v.tracks[0].berths.find((b) => b.id === '0110').code, '2C45');
  assert.equal(v.tracks[1].berths.find((b) => b.id === '0110').code, '1D22');
  assert.equal(v.quietMins, 0, 'heard from one of its areas');
});

test('live National Rail stops replace the timetable ahead, including cancelled stops and passing points', () => {
  const svc = { rid: 'R1', uid: 'C12345', trainid: '1D14', operator: 'Northern', length: 4, isCancelled: false, delayReason: 'A late running train',
    std: '2026-11-09T14:08:00', etd: '2026-11-09T14:13:00', platform: '2', destination: [{ locationName: 'Leeds' }],
    subsequentLocations: [
      { locationName: 'Skelton Jn', tiploc: 'SKELTON', isPass: true, wtp: '2026-11-09T14:11:30' },
      { locationName: 'Wakefield Kirkgate', crs: 'WKK', sta: '2026-11-09T14:32:00', eta: '2026-11-09T14:37:00', platform: '1', isCancelled: true },
      { locationName: 'Leeds', crs: 'LDS', sta: '2026-11-09T14:50:00', eta: '2026-11-09T14:55:00', platform: '15', platformIsHidden: true }
    ] };
  const board = { locationName: 'Adwick', trainServices: [{ uid: 'X', trainid: '2X99' }, svc] };
  const found = findService(board, { uid: 'C12345', headcode: '1D14' });
  assert.equal(found.rid, 'R1');
  const live = serviceToLive(found, { name: 'Adwick', crs: 'AWK' });
  const base = { stops: [{ name: 'Doncaster', state: 'passed' }, { name: 'Adwick', state: 'due' }], dest: 'Leeds' };
  const d = mergeLive(base, live);
  assert.deepEqual(d.stops.map((s) => s.name), ['Doncaster', 'Adwick', 'Skelton Jn', 'Wakefield Kirkgate', 'Leeds']);
  assert.equal(d.stops[2].pass, true);
  assert.equal(d.stops[3].cancelled, true);
  assert.equal(d.next.name, 'Adwick');
  assert.equal(d.stops[4].hiddenPlatform, '15');
  assert.equal(d.stops[4].expected, '14:55');
  assert.equal(d.delayReason, 'A late running train');
  assert.equal(staffTime(Date.UTC(2026, 6, 1, 13, 5, 9)), '20260701T140509'); // BST
});

test('Staff Version quirks: no estimate means "Delayed", reasons are codes, times have seconds', () => {
  const live = serviceToLive({ uid: 'U', trainid: '1E14', sta: '2026-11-09T14:14:00', ata: '2026-11-09T14:40:36', std: '2026-11-09T14:17:00', departureType: 'Delayed', delayReason: { value: 871 },
    subsequentLocations: [{ locationName: 'COLTONJ', tiploc: 'COLTONJ', isPass: true, std: '2026-11-09T14:21:00', departureType: 'Delayed' }] }, { name: 'York', crs: 'YRK' });
  assert.equal(live.stops[0].expected, 'Delayed');
  assert.equal(live.stops[0].booked, '14:17');
  assert.equal(live.stops[1].pass, true);
  assert.equal(live.delayReason, 'Reason code 871');
  const b = normaliseStaff({ trainServices: [{ trainid: '1E14', std: '2026-11-09T14:17:00', departureType: 'Delayed', destination: [{ locationName: 'London Kings Cross' }], platform: '9' }] });
  assert.equal(b.services[0].expected, 'Delayed');
  assert.equal(b.services[0].delay, null);
});

test('reason codes keep the code and add Darwin\'s meaning when the list is loaded', () => {
  assert.equal(textOf({ value: 999 }), 'Reason code 999', 'no meaning made up');
  reasonMap.set('999', { late: 'This train has been delayed by a test', canc: 'This train has been cancelled because of a test' });
  assert.equal(textOf({ value: 999 }), 'This train has been delayed by a test (code 999)');
  assert.equal(textOf('999', 'canc'), 'This train has been cancelled because of a test (code 999)');
  reasonMap.delete('999');
});

console.log(`\n${passed} timetable and panel tests passed`);
