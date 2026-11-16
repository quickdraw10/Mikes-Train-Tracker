// Eurostar: GTFS timetable + GTFS-RT live, boards in each station's own time zone
import assert from 'node:assert/strict';
import { strToU8 } from 'fflate';
import { createEurostar, loadGtfsFiles, applyFeed, ezBoard, ezTrain, parseCsv, epochOf, clockIn } from './eurostar.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const now = Date.now();
const ymd = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
// times an hour and two hours from now, written in Paris time as GTFS does
// written as GTFS does: hours past midnight continue from 24 on the service day
const paris = (minsFromNow) => {
  const t = new Date(now + minsFromNow * 60000);
  const day = t.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
  const [h, m, sec] = t.toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23' }).split(':').map(Number);
  return `${String(h + (day > ymd ? 24 : 0)).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};
const london = (minsFromNow) => new Date(now + minsFromNow * 60000).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const files = {
  'agency.txt': strToU8('agency_id,agency_name,agency_url,agency_timezone\nES,Eurostar,https://www.eurostar.com,Europe/Paris\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,stop_timezone\n7015400,London St Pancras International,51.531,-0.126,1,,Europe/London\n7015400_P,London St Pancras International,51.531,-0.126,0,7015400,Europe/London\n8727100,Paris Nord,48.880,2.355,1,,Europe/Paris\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name,trip_headsign\nR1,S1,T9014,9014,Paris Nord\nR1,S1,T9018,9018,Paris Nord\n'),
  'stop_times.txt': strToU8(`trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT9014,${paris(60)},${paris(60)},7015400_P,1\nT9014,${paris(200)},${paris(200)},8727100,2\nT9018,${paris(120)},${paris(120)},7015400_P,1\nT9018,${paris(260)},${paris(260)},8727100,2\n`),
  'calendar_dates.txt': strToU8(`service_id,date,exception_type\nS1,${ymd},1\n`)
};

test('CSV with quotes and commas', () => {
  const r = parseCsv('a,b\n"x, y","he said ""hi"""\n');
  assert.equal(r[0].a, 'x, y'); assert.equal(r[0].b, 'he said "hi"');
});

test('GTFS time in Paris shown in London time at St Pancras', () => {
  const ms = epochOf(ymd, paris(60), 'Europe/Paris');
  assert.ok(Math.abs(ms - (now + 60 * 60000)) < 1000 * 60);
  assert.equal(clockIn(ms, 'Europe/London'), london(60));
});

const ez = createEurostar();
loadGtfsFiles(ez, files);
applyFeed(ez, { entity: [
  { tripUpdate: { trip: { tripId: 'T9014', startDate: ymd }, stopTimeUpdate: [{ stopSequence: 1, departure: { delay: 900 } }] } },
  { tripUpdate: { trip: { tripId: 'T9018', startDate: ymd, scheduleRelationship: 'CANCELED' }, stopTimeUpdate: [] } },
  { alert: { headerText: { translation: [{ language: 'en', text: 'Disruption in the Channel Tunnel' }] }, informedEntity: [{ trip: { tripId: 'T9014' } }] } }
] });

test('stations: platforms roll up to their station; codes start EZ', () => {
  assert.equal(ez.stations.size, 2);
  assert.ok([...ez.stations.values()].some((s) => s.crs === 'EZ7015400' && s.name === 'London St Pancras International'));
});

test('St Pancras departures: live delay with Eurostar\'s alert, a cancellation, London times', () => {
  const b = ezBoard(ez, 'EZ7015400', 'dep', now);
  assert.equal(b.services.length, 2);
  const [a, c] = b.services;
  assert.equal(a.headcode, '9014'); assert.equal(a.booked, london(60)); assert.equal(a.delay, 15); assert.equal(a.expected, london(75));
  assert.equal(a.place, 'Paris Nord'); assert.equal(a.reason, 'Disruption in the Channel Tunnel');
  assert.equal(c.cancelled, true); assert.equal(c.expected, 'Cancelled');
});

test('train page: stops in local time, delay carried on to later stops', () => {
  const id = ezBoard(ez, 'EZ7015400', 'dep', now).services[0].id;
  const d = ezTrain(ez, id);
  assert.equal(d.origin, 'London St Pancras International'); assert.equal(d.dest, 'Paris Nord');
  assert.equal(d.stops[0].booked, london(60));
  assert.equal(d.stops[1].late, 15, 'the 15 minutes carries on to Paris');
  assert.equal(d.delayReason, 'Disruption in the Channel Tunnel');
});

console.log(`\n${passed} Eurostar tests passed`);
