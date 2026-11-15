// Location boards: any timing point, with what TRUST reported there
import assert from 'node:assert/strict';
import { searchLocations, locationBoard } from './location.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const nowM = (() => { const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).split(':'); return +h * 60 + +m; })();
const tiplocs = new Map([['DONC', { crs: 'DON', stanox: '23421', name: 'Doncaster' }], ['DECOYNJ', { crs: null, stanox: '23430', name: 'Doncaster Decoy North Jn' }], ['YORK', { crs: 'YRK', stanox: '05001', name: 'York' }]]);
const pass1 = { uid: 'P1', atoc: 'GR', cat: 'XX', headcode: '1S20', locs: [{ t: 'DONC', dep: nowM - 20 }, { t: 'DECOYNJ', pass: nowM - 18 }, { t: 'YORK', arr: nowM + 5 }] };
const frt = { uid: 'F1', atoc: 'ZZ', cat: 'EE', headcode: '4E50', locs: [{ t: 'YORK', dep: nowM }, { t: 'DECOYNJ', pass: nowM + 30 }, { t: 'DONC', arr: nowM + 35 }] };
const tt = { loadedAt: 1, tiplocs, byDate: new Map([[today, new Map([['P1', pass1], ['F1', frt]])]]) };
const running = { id: '1S20X', sched: pass1, runDate: today, delay: 6, reports: { 23430: { dep: Date.now() - 12 * 60000, lateDep: 6, srcDep: 'AUTOMATIC' } } };
const frtLive = { id: '4E50X', sched: frt, runDate: today, delay: 2, reports: {}, at: { name: 'York' }, event: 'Departed' };
const nat = { tt, trains: new Map([[running.id, running], [frtLive.id, frtLive]]) };

test('search finds a junction by name and by code', () => {
  assert.equal(searchLocations(tt, 'decoy')[0].tiploc, 'DECOYNJ');
  assert.equal(searchLocations(tt, 'DECOYNJ')[0].name, 'Doncaster Decoy North Jn');
});

test('the junction board: a passed train with its reported time, and a freight still on its way', () => {
  const b = locationBoard(nat, 'DECOYNJ');
  assert.equal(b.rows.length, 2);
  const [p, f] = b.rows;
  assert.equal(p.headcode, '1S20'); assert.equal(p.state, 'passed'); assert.equal(p.late, 6); assert.equal(p.src, 'AUTOMATIC'); assert.equal(p.kind, 'passes');
  assert.equal(f.freight, true); assert.equal(f.state, 'running'); assert.equal(f.nowLate, 2); assert.equal(f.at, 'left York');
});

console.log(`\n${passed} location board tests passed`);
