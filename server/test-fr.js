// France (SNCF): board and train parsing against SNCF-shaped responses
import assert from 'node:assert/strict';
import { createFrance, frBoard, frTrain, hm, lateBy } from './fr.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
process.env.SNCF_KEY = 'test';
const reply = (body) => { globalThis.fetch = async () => ({ ok: true, json: async () => body }); };

await test('times: "20261110T143000" -> 14:30, lateness in minutes', () => {
  assert.equal(hm('20261110T143000'), '14:30');
  assert.equal(lateBy('20261110T143000', '20261110T145200'), 22);
  assert.equal(lateBy('20261110T235500', '20261111T000500'), 10);
});

await test('board: live late train, on-time train, cancelled train, no live data', async () => {
  const fr = createFrance();
  fr.stations.set('FR87686006', { crs: 'FR87686006', name: 'Paris Gare de Lyon' });
  reply({
    departures: [
      { display_informations: { direction: 'Marseille Saint-Charles (Marseille)', trip_short_name: '6111', commercial_mode: 'TGV INOUI', network: 'TGV INOUI' },
        stop_date_time: { departure_date_time: '20261110T145200', base_departure_date_time: '20261110T143000', data_freshness: 'realtime' },
        links: [{ type: 'vehicle_journey', id: 'vehicle_journey:SNCF:2026-11-10:6111' }, { type: 'disruption', id: 'd1' }] },
      { display_informations: { direction: 'Lyon Part Dieu', trip_short_name: '6613', commercial_mode: 'TGV INOUI' },
        stop_date_time: { departure_date_time: '20261110T150000', base_departure_date_time: '20261110T150000', data_freshness: 'realtime' },
        links: [{ type: 'vehicle_journey', id: 'vj2' }] },
      { display_informations: { direction: 'Dijon Ville', trip_short_name: '891234', commercial_mode: 'TER' },
        stop_date_time: { departure_date_time: '20261110T151000', base_departure_date_time: '20261110T151000', data_freshness: 'realtime' },
        links: [{ type: 'vehicle_journey', id: 'vj3' }, { type: 'disruption', id: 'd2' }] },
      { display_informations: { direction: 'Nice Ville', trip_short_name: '6173', commercial_mode: 'OUIGO' },
        stop_date_time: { departure_date_time: '20261110T153000', base_departure_date_time: '20261110T153000', data_freshness: 'base_schedule' },
        links: [{ type: 'vehicle_journey', id: 'vj4' }] }
    ],
    disruptions: [
      { id: 'd1', severity: { effect: 'SIGNIFICANT_DELAYS' }, messages: [{ text: 'Panne de signalisation' }] },
      { id: 'd2', severity: { effect: 'NO_SERVICE' }, cause: 'Mouvement social' }
    ]
  });
  const b = await frBoard(fr, 'FR87686006', 'dep');
  assert.equal(b.name, 'Paris Gare de Lyon');
  const [late, ok, canc, nolive] = b.services;
  assert.equal(late.booked, '14:30'); assert.equal(late.expected, '14:52'); assert.equal(late.delay, 22);
  assert.equal(late.place, 'Marseille Saint-Charles'); assert.equal(late.reason, 'Panne de signalisation');
  assert.equal(late.id, 'fr:6111:20261110'); assert.ok(fr.trains.has('fr:6111:20261110'));
  assert.equal(ok.expected, 'On time');
  assert.equal(canc.cancelled, true); assert.equal(canc.expected, 'Cancelled'); assert.equal(canc.reason, 'Mouvement social');
  assert.equal(nolive.expected, null, 'no live data is not "On time"'); assert.equal(nolive.delay, null);
});

await test('train: stops with booked and amended times; none marked as passed', async () => {
  const fr = createFrance();
  fr.trains.set('fr:6111:20261110', { vj: 'vj1', num: '6111', mode: 'TGV INOUI', at: Date.now() });
  reply({
    vehicle_journeys: [{ stop_times: [
      { departure_time: '143000', arrival_time: '143000', stop_point: { id: 'sp1', name: 'Paris Gare de Lyon (Paris)', stop_area: { id: 'stop_area:SNCF:87686006' } } },
      { departure_time: '164500', arrival_time: '164200', stop_point: { id: 'sp2', name: 'Avignon TGV', stop_area: { id: 'stop_area:SNCF:87318964' } } },
      { departure_time: '173500', arrival_time: '173500', stop_point: { id: 'sp3', name: 'Marseille Saint-Charles', stop_area: { id: 'stop_area:SNCF:87751008' } } }] }],
    disruptions: [{ severity: { effect: 'SIGNIFICANT_DELAYS' }, messages: [{ text: 'Panne de signalisation' }], impacted_objects: [{ impacted_stops: [
      { stop_point: { id: 'sp1' }, base_departure_time: '143000', amended_departure_time: '145200' },
      { stop_point: { id: 'sp2' }, base_arrival_time: '164200', amended_arrival_time: '170400' },
      { stop_point: { id: 'sp3' }, base_arrival_time: '173500', amended_arrival_time: '175700' }] }] }]
  });
  const d = await frTrain(fr, 'fr:6111:20261110');
  assert.equal(d.origin, 'Paris Gare de Lyon'); assert.equal(d.dest, 'Marseille Saint-Charles');
  assert.equal(d.stops[1].booked, '16:42'); assert.equal(d.stops[1].expected, '17:04');
  assert.equal(d.delay, 22); assert.equal(d.delayReason, 'Panne de signalisation');
  assert.ok(d.stops.every((s) => s.state === 'due'));
  assert.equal(d.stops[0].crs, 'FR87686006');
});

console.log(`\n${passed} France tests passed`);
