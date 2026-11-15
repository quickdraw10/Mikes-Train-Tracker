// Trains placed on a line's stretches by their own timetable and TRUST reports
import assert from 'node:assert/strict';
import { trainsOnLine, corridor } from './linepos.js';
import { band } from '../app/model.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

// timing points: stations (with CRS) and points in between without one
const tip = (code, crs, stanox, name) => [code, { crs, stanox, name }];
const tiplocs = new Map([
  tip('NWCSTLE', 'NCL', '1', 'Newcastle'), tip('MRPTH', 'MPT', '2', 'Morpeth'), tip('ALNMTH', 'ALM', '3', 'Alnmouth'),
  tip('CHTHILL', 'CHT', '4', 'Chathill'), tip('TWDMTH', null, '5', 'Tweedmouth'), tip('BRWK', 'BWK', '6', 'Berwick-upon-Tweed'),
  tip('DUNBAR', 'DUN', '7', 'Dunbar'), tip('EDINBUR', 'EDB', '8', 'Edinburgh')
]);
const north = { uid: 'A', locs: ['NWCSTLE', 'MRPTH', 'ALNMTH', 'CHTHILL', 'TWDMTH', 'BRWK', 'DUNBAR', 'EDINBUR'].map((t) => ({ t })) };
const south = { uid: 'B', locs: [...north.locs].reverse() };
const tt = { loadedAt: 1, tiplocs, byDate: new Map([['2026-11-15', new Map([['A', north], ['B', south]])]]) };
const LINE = ['NCL', 'MPT', 'ALM', 'BWK', 'DUN', 'EDB'];

test('points between drawn stations belong to that stretch', () => {
  const c = corridor(tt, LINE);
  assert.equal(c.pos.get('ALNMTH'), 2);
  assert.ok(c.pos.get('CHTHILL') > 2 && c.pos.get('CHTHILL') < 3);
  assert.ok(c.pos.get('TWDMTH') > c.pos.get('CHTHILL') && c.pos.get('TWDMTH') < 3);
});

test('a late train last reported at Chathill counts on Alnmouth–Berwick, heading north', () => {
  const nat = { tt, trains: new Map([['t1', { id: 't1', code: '1S12', delay: 14, sched: north, reports: { 1: { dep: 1 }, 2: { dep: 1 }, 3: { dep: 1 }, 4: { dep: 1 } }, updated: Date.now() }]]) };
  const [t] = trainsOnLine(nat, LINE, band);
  assert.ok(t.pos >= 2 && t.pos < 3, 'on stretch 2 (Alnmouth–Berwick)');
  assert.equal(t.dir, 'down'); assert.equal(t.delay, 14); assert.equal(t.last, 'Chathill');
});

test('southbound train that has left Berwick is on Berwick–Alnmouth, heading south', () => {
  const nat = { tt, trains: new Map([['t2', { id: 't2', code: '1E05', delay: 6, sched: south, reports: { 8: { dep: 1 }, 7: { dep: 1 }, 6: { dep: 1 } }, updated: Date.now() }]]) };
  const [t] = trainsOnLine(nat, LINE, band);
  assert.ok(t.pos >= 2 && t.pos < 3); assert.equal(t.dir, 'up');
});

test('arrived at Berwick heading north: still on the stretch it came along', () => {
  const nat = { tt, trains: new Map([['t3', { id: 't3', code: '1S14', delay: 3, sched: north, reports: { 1: { dep: 1 }, 3: { dep: 1 }, 6: { arr: 1 } }, updated: Date.now() }]]) };
  const [t] = trainsOnLine(nat, LINE, band);
  assert.ok(t.pos >= 2 && t.pos < 3);
});

test('a train elsewhere is not counted on this line', () => {
  const other = { uid: 'C', locs: [{ t: 'ELSEWHR' }] };
  const nat = { tt, trains: new Map([['t4', { id: 't4', code: '2X00', sched: other, reports: { 9: { dep: 1 } }, updated: Date.now() }]]) };
  assert.equal(trainsOnLine(nat, LINE, band).length, 0);
});

console.log(`\n${passed} line placement tests passed`);
