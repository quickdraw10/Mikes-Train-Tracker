// Finding a train by the station and time people know it by
import assert from 'node:assert/strict';
import { findTrains, minsOf, scheduleOnly } from './findtrain.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const tiplocs = new Map([['GLGC', { crs: 'GLC', name: 'Glasgow Central' }], ['CRSTRS', { crs: 'CRS', name: 'Carstairs' }], ['CARLILE', { crs: 'CAR', name: 'Carlisle' }], ['EUSTON', { crs: 'EUS', name: 'London Euston' }]]);
const a = { uid: 'G1', atoc: 'VT', cat: 'XX', headcode: '1M15', locs: [{ t: 'GLGC', dep: 17 * 60 + 34, pdep: 17 * 60 + 34 }, { t: 'CRSTRS', pass: 18 * 60 }, { t: 'CARLILE', arr: 18 * 60 + 50, dep: 18 * 60 + 52, parr: 18 * 60 + 50, pdep: 18 * 60 + 52 }, { t: 'EUSTON', arr: 22 * 60 + 10, parr: 22 * 60 + 10 }] };
const b = { uid: 'G2', atoc: 'TP', cat: 'OO', headcode: '1Y99', locs: [{ t: 'GLGC', dep: 17 * 60 + 40, pdep: 17 * 60 + 40 }, { t: 'CARLILE', arr: 19 * 60, parr: 19 * 60 }] };
const freight = { uid: 'F1', atoc: 'ZZ', cat: 'EE', headcode: '4S00', locs: [{ t: 'GLGC', dep: 17 * 60 + 34 }, { t: 'CARLILE', arr: 20 * 60 }] };
const tt = { loadedAt: 1, tiplocs, byDate: new Map([[today, new Map([['G1', a], ['G2', b], ['F1', freight]])]]) };
const running = { id: '871M15ABC', code: '1M15', sched: a, runDate: today, delay: 12, at: { name: 'Carlisle' }, event: 'Departed' };
const nat = { tt, trains: new Map([[running.id, running]]) };

test('times read as minutes', () => { assert.equal(minsOf('17:34'), 1054); assert.equal(minsOf('1734'), 1054); assert.equal(minsOf('25:00'), null); });

test('the 17:34 from Glasgow Central is found and linked to the running train, freight left out', () => {
  const r = findTrains(nat, ['GLC'], '17:34');
  assert.equal(r.exact, 1);
  const [t] = r.trains;
  assert.equal(t.id, running.id); assert.equal(t.headcode, '1M15'); assert.equal(t.dest, 'London Euston');
  assert.equal(t.delay, 12); assert.equal(t.status, 'Left Carlisle'); assert.equal(t.startsHere, true);
});

test('a calling point works too: the 18:52 from Carlisle is the same train', () => {
  const r = findTrains(nat, ['CAR'], '18:52');
  assert.equal(r.trains[0].id, running.id); assert.equal(r.trains[0].startsHere, false); assert.equal(r.trains[0].origin, 'Glasgow Central');
});

test('no exact match: the nearest within 15 minutes are offered', () => {
  const r = findTrains(nat, ['GLC'], '17:38');
  assert.equal(r.exact, 0); assert.equal(r.trains[0].headcode, '1Y99');
});

test('a train with no live reports opens from the timetable', () => {
  const d = scheduleOnly(nat, `sch:G2:${today}`, (tt2, t) => ({ code: t.code, stops: t.sched.locs.map((l) => l.t) }));
  assert.equal(d.code, '1Y99'); assert.ok(d.liveNote);
  assert.equal(scheduleOnly(nat, `sch:G1:${today}`, () => ({})).redirect, running.id);
});

test('a finished train keeps what happened: found with its arrival, opened with its reports', () => {
  const nat2 = { tt, trains: new Map(), history: new Map([[`G2|${today}`, { id: 'old', code: '1Y99', uid: 'G2', runDate: today, delay: 4, terminated: true, at: { name: 'Carlisle' }, reports: { 1: { dep: 1 } }, updated: Date.now() }]]) };
  const r = findTrains(nat2, ['GLC'], '17:40');
  assert.equal(r.trains[0].status, 'Arrived Carlisle'); assert.equal(r.trains[0].delay, 4);
  const d = scheduleOnly(nat2, `sch:G2:${today}`, (tt2, t) => ({ code: t.code, delay: t.delay }));
  assert.equal(d.delay, 4); assert.match(d.liveNote, /finished/);
});

console.log(`\n${passed} find-a-train tests passed`);
