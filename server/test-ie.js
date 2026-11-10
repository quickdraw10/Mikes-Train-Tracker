// Tests for the Irish Rail adapter, with replies in Irish Rail's published format.
import assert from 'node:assert/strict';
import { parseList, parseMessage, createIrish, irishTrainsIn } from './ie.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

test('reads the flat XML lists, whatever the field casing', () => {
  const xml = `<ArrayOfObjTrainPositions><objTrainPositions><TrainStatus>R</TrainStatus><TrainLatitude>53.3531</TrainLatitude><TrainLongitude>-6.24591</TrainLongitude><TrainCode>E109</TrainCode><TrainDate>10 Nov 2026</TrainDate><PublicMessage>E109\\n11:00 - Dublin Pearse to Greystones (3 mins late)\\nDeparted Tara Street next stop Dublin Pearse</PublicMessage><Direction>Southbound</Direction></objTrainPositions></ArrayOfObjTrainPositions>`;
  const r = parseList(xml, 'objTrainPositions');
  assert.equal(r.length, 1);
  assert.equal(r[0].traincode, 'E109');
  assert.equal(r[0].trainlatitude, '53.3531');
});

test('the public message gives route, lateness and where it is', () => {
  const m = parseMessage('AA509\\n11:00 - Waterford to Dublin Heuston (0 mins late)\\nDeparted Waterford next stop Thomastown');
  assert.equal(m.origin, 'Waterford');
  assert.equal(m.dest, 'Dublin Heuston');
  assert.equal(m.delay, 0);
  assert.equal(m.last, 'Waterford');
  assert.equal(m.next, 'Thomastown');
  assert.equal(parseMessage('X\n09:00 - A to B (2 mins early)\nArrived A').delay, -2);
  assert.equal(parseMessage('X\nNo information').delay, null, 'no figure, no guess');
});

test('only trains inside the map view are returned', () => {
  const ie = createIrish();
  ie.trains.set('ie:E1:d', { id: 'ie:E1:d', code: 'E1', lat: 53.35, lon: -6.25, delay: 3 });
  ie.trains.set('ie:A1:d', { id: 'ie:A1:d', code: 'A1', lat: 51.9, lon: -8.47, delay: 0 });
  const r = irishTrainsIn(ie, { w: -6.5, e: -6.0, s: 53.2, n: 53.5 });
  assert.deepEqual(r.map((t) => t.code), ['E1']);
  assert.equal(r[0].country, 'ie');
});

console.log(`\n${passed} Irish Rail tests passed`);
