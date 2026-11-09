// Tests for the map (national train tracking) and station boards.
import assert from 'node:assert/strict';
import { createNational, handleNational, trainsIn, movesNear, positionOf } from './national.js';
import { normalise, delayBetween } from './ldb.js';
import { searchStations, nearest } from '../app/geo.js';
import { createNationalSim } from '../app/national-sim.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const stanoxCrs = { '18001': 'NOT', '18002': 'BEE' };
const box = { w: -1.4, s: 52.8, e: -0.9, n: 53.1 };

test('a train reporting at a station appears on the map there, with its delay', () => {
  const nat = createNational();
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '181D42MW08', loc_stanox: '18001', event_type: 'ARRIVAL', timetable_variation: '6', variation_status: 'LATE' } }], nat, stanoxCrs);
  const r = trainsIn(nat, box);
  assert.equal(r.total, 1);
  assert.equal(r.trains[0].code, '1D42');
  assert.equal(r.trains[0].last, 'Nottingham');
  assert.equal(r.trains[0].band, 'mid');
});

test('after departing it stays at the last reported station: nothing is estimated', () => {
  const nat = createNational();
  const now = Date.now();
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '181D42MW08', loc_stanox: '18001', event_type: 'DEPARTURE', next_report_stanox: '18002', next_report_run_time: '4', timetable_variation: '0', variation_status: 'ON TIME' } }], nat, stanoxCrs, now);
  const t = nat.trains.get('181D42MW08');
  const p = positionOf(t, now + 2 * 60000);
  assert.deepEqual(p, { lat: t.at.lat, lon: t.at.lon }, 'still shown at Nottingham until Beeston reports it');
});

test('timing points that are not stations update delay but not position', () => {
  const nat = createNational();
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '181D42MW08', loc_stanox: '18001', event_type: 'ARRIVAL', timetable_variation: '0', variation_status: 'ON TIME' } }], nat, stanoxCrs);
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '181D42MW08', loc_stanox: '99999', event_type: 'DEPARTURE', timetable_variation: '12', variation_status: 'LATE' } }], nat, stanoxCrs);
  const r = trainsIn(nat, box);
  assert.equal(r.trains[0].last, 'Nottingham');
  assert.equal(r.trains[0].delay, 12);
});

test('area movements list what happened nearby, newest first', () => {
  const nat = createNational();
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '181D42MW08', loc_stanox: '18001', event_type: 'ARRIVAL', timetable_variation: '0', variation_status: 'ON TIME' } }], nat, stanoxCrs);
  handleNational([{ header: { msg_type: '0003' }, body: { train_id: '182N11MW08', loc_stanox: '18002', event_type: 'DEPARTURE', timetable_variation: '3', variation_status: 'LATE' } }], nat, stanoxCrs);
  const m = movesNear(nat, 52.947, -1.145, 15).moves;
  assert.equal(m.length, 2);
  assert.equal(m[0].code, '2N11');
  assert.equal(movesNear(nat, 51.5, -0.12, 15).moves.length, 0);
});

test('board delay is worked out from booked and expected times, across midnight too', () => {
  assert.equal(delayBetween('17:05', 'On time'), 0);
  assert.equal(delayBetween('17:05', '17:12'), 7);
  assert.equal(delayBetween('23:58', '00:04'), 6);
  assert.equal(delayBetween('17:05', 'Delayed'), null);
});

test('National Rail board replies are turned into board rows', () => {
  const b = normalise({ locationName: 'Nottingham', crs: 'NOT', trainServices: [
    { std: '17:05', etd: '17:09', platform: '4', operator: 'East Midlands Railway', destination: [{ locationName: 'Matlock' }], serviceID: 'a' },
    { std: '17:10', etd: 'Cancelled', isCancelled: true, operator: 'CrossCountry', destination: [{ locationName: 'Cardiff Central' }], cancelReason: 'a broken down train', serviceID: 'b' },
    { sta: '17:20', eta: 'On time', origin: [{ locationName: 'Leicester' }], serviceID: 'c' }
  ] }, 'dep');
  assert.equal(b.services.length, 2);
  assert.equal(b.services[0].delay, 4);
  assert.equal(b.services[0].place, 'Matlock');
  assert.equal(b.services[1].cancelled, true);
  const a = normalise({ trainServices: [{ sta: '17:20', eta: 'On time', origin: [{ locationName: 'Leicester' }] }] }, 'arr');
  assert.equal(a.services[0].place, 'Leicester');
});

test('station search finds by name, start of a word, or code', () => {
  assert.equal(searchStations('notting')[0].crs, 'NOT');
  assert.equal(searchStations('NOT')[0].crs, 'NOT');
  assert.equal(searchStations('parkway').length > 3, true);
  assert.equal(nearest(52.95, -1.15, 1)[0].crs, 'NOT');
});

test('demo boards never list the station as its own destination', () => {
  const sim = createNationalSim(50);
  for (let i = 0; i < 20; i++) assert.ok(sim.board('NOT', 'dep').services.every((s) => s.place !== 'Nottingham'));
});

console.log(`\n${passed} map and board tests passed`);
