// Tests for the Irish Rail adapter, with replies in Irish Rail's published format.
import assert from 'node:assert/strict';
import { parseList, parseMessage, createIrish, irishTrainsIn, hm, applyTrainsXml, irishBoard } from './ie.js';

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

test('00:00:00 means no time, not midnight', () => {
  assert.equal(hm('00:00:00'), null);
  assert.equal(hm('09:07:00'), '09:07');
  assert.equal(hm(''), null);
});

test('a frozen positions feed (last night\'s trains the next morning) puts nothing on the map, and says why', () => {
  const ie = createIrish();
  const at = Date.parse('2026-11-17T06:54:00Z');
  const xml = `<ArrayOfObjTrainPositions><objTrainPositions><TrainStatus>R</TrainStatus><TrainLatitude>51.9</TrainLatitude><TrainLongitude>-8.45</TrainLongitude><TrainCode>A314</TrainCode><TrainDate>16 Nov 2026</TrainDate><PublicMessage>A314\\n20:55 - Cork to Tralee (0 mins late)\\nDeparted Cork next stop Mallow</PublicMessage><Direction>To Tralee</Direction></objTrainPositions></ArrayOfObjTrainPositions>`;
  applyTrainsXml(ie, xml, at);
  assert.equal(ie.trains.size, 0);
  assert.equal(ie.feed.stale, 1);
  assert.match(ie.error, /out of date/);
  // the same train late last night, just after midnight, still counts
  applyTrainsXml(ie, xml, Date.parse('2026-11-17T00:20:00Z'));
  assert.equal(ie.trains.size, 1);
  assert.equal(ie.error, null);
});

await (async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => `<ArrayOfObjStationData><objStationData><Traincode>E802 </Traincode><Stationfullname>Dublin Connolly</Stationfullname><Traindate>17 Nov 2026</Traindate><Origin>Bray</Origin><Destination>Malahide</Destination><Status>No Information</Status><Lastlocation></Lastlocation><Late>0</Late><Exparrival>07:02</Exparrival><Expdepart>07:04</Expdepart><Scharrival>07:02</Scharrival><Schdepart>07:04</Schdepart><Locationtype>S</Locationtype></objStationData><objStationData><Traincode>D903</Traincode><Stationfullname>Dublin Connolly</Stationfullname><Traindate>17 Nov 2026</Traindate><Origin>Dublin Connolly</Origin><Destination>Maynooth</Destination><Status>En Route</Status><Lastlocation>Departed Howth Junction</Lastlocation><Late>3</Late><Expdepart>07:08</Expdepart><Schdepart>07:05</Schdepart><Locationtype>O</Locationtype></objStationData></ArrayOfObjStationData>` });
  try {
    const b = await irishBoard(createIrish(), 'CNLLY', 'dep');
    const e = b.services.find((s) => s.headcode === 'E802');
    assert.equal(e.expected, null); assert.equal(e.delay, null); assert.equal(e.noLive, true);
    const d = b.services.find((s) => s.headcode === 'D903');
    assert.equal(d.expected, '07:08'); assert.equal(d.delay, 3);
    passed++; console.log('  ✓ "No Information" with "0 late" is shown as no live time, not On time');
  } finally { globalThis.fetch = real; }
})();

console.log(`\n${passed} Irish Rail tests passed`);
