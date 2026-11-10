// Tests for the TfL adapter: names and placing trains from TfL's location text.
import assert from 'node:assert/strict';
import { tidy, placeFromText, createTfl, tflTrainsIn, parseSummary } from './tfl.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

const names = new Map([
  ['bond street', { lat: 51.514, lon: -0.149 }],
  ['oxford circus', { lat: 51.515, lon: -0.142 }],
  ['baker street', { lat: 51.523, lon: -0.157 }],
  ["king's cross st pancras".replace(/'/g, ''), { lat: 51.530, lon: -0.124 }]
]);

test('station names lose "Underground Station"', () => {
  assert.equal(tidy('Baker Street Underground Station'), 'Baker Street');
  assert.equal(tidy('Canary Wharf DLR Station'), 'Canary Wharf');
});

test('a train between two stations is drawn halfway between them', () => {
  const p = placeFromText('Between Bond Street and Oxford Circus', names);
  assert.ok(Math.abs(p.lat - 51.5145) < 1e-6 && Math.abs(p.lon + 0.1455) < 1e-6);
});

test('at or approaching a station: drawn at that station', () => {
  assert.equal(placeFromText('At Baker Street Platform 2', names).lon, -0.157);
  assert.equal(placeFromText('Approaching Oxford Circus', names).lat, 51.515);
});

test('a location TfL gives that we can\'t match is not drawn (no guessing)', () => {
  assert.equal(placeFromText('At Depot', names), null);
  assert.equal(placeFromText('', names), null);
  assert.equal(placeFromText('Between Bond Street and Nowhere', names), null);
});

test('only TfL trains inside the view, with their line colour and no lateness', () => {
  const tfl = createTfl();
  tfl.trains.set('tfl:victoria:201', { id: 'tfl:victoria:201', code: 'VIC', lat: 51.5, lon: -0.14, color: '#0098D4', lineName: 'Victoria', next: 'Victoria', where: 'At Victoria' });
  const r = tflTrainsIn(tfl, { w: -0.2, e: -0.1, s: 51.4, n: 51.6 });
  assert.equal(r.length, 1);
  assert.equal(r[0].delay, null);
  assert.equal(r[0].color, '#0098D4');
  assert.equal(tflTrainsIn(tfl, { w: 0, e: 0.1, s: 51.4, n: 51.6 }).length, 0);
});

test('Trackernet summary: every train by set number, with its location and time to each station', () => {
  const xml = '<ROOT><Time TimeStamp="2026/11/10 10:40:00"/><S Code="BNK" N="Bank."><P N="Westbound - Platform 1" Code="0"><T S="051" T="12" D="123" C="2:30" L="Between Liverpool Street and Bank" DE="Ealing Broadway"/><T S="000" T="0" D="1" C="-" L="" DE="X"/></P></S><S Code="STP" N="St. Paul\'s."><P N="Westbound - Platform 1" Code="0"><T S="051" T="12" D="123" C="4:10" L="Between Liverpool Street and Bank" DE="Ealing Broadway"/></P></S></ROOT>';
  const r = parseSummary(xml);
  assert.equal(r.length, 3);
  assert.equal(r[0].set, '051');
  assert.equal(r[0].station, 'Bank');
  assert.equal(r[0].secs, 150);
  assert.equal(r[2].station, "St. Paul's");
});

console.log(`\n${passed} TfL tests passed`);
