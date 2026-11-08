// Runs sample TD and TRUST messages (in Network Rail's real formats)
// through the parsers and checks the picture the app would draw.
//   npm test

import assert from 'node:assert/strict';
import { ROUTES } from '../app/layout.js';
import { emptyState, buildView, signalState } from '../app/model.js';
import { handleSClass } from './sclass.js';
import { createDecoder } from './decode.js';
import { handleTd } from './td.js';
import { handleTrust, buildStanoxIndex, headcodeOf, delayOf, trustTime } from './trust.js';
import { extract } from './corpus.js';
import { extractArea as extractSmart } from './smart.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓', name); }

// Give the route stations made-up STANOX codes for the test
ROUTES[0].stations.forEach((s, i) => { s.stanox = ['9000' + i]; });
const idx = buildStanoxIndex();
const areas = new Set(['VC']);

test('headcode comes from characters 3–6 of train_id', () => {
  assert.equal(headcodeOf('721J24MW08'), '1J24');
});

test('delay sign follows variation_status', () => {
  assert.equal(delayOf({ timetable_variation: '3', variation_status: 'LATE' }), 3);
  assert.equal(delayOf({ timetable_variation: '1', variation_status: 'EARLY' }), -1);
  assert.equal(delayOf({ timetable_variation: '0', variation_status: 'ON TIME' }), 0);
});

test('TD interpose, step and cancel move a headcode between berths', () => {
  const raw = emptyState();
  handleTd([{ CC_MSG: { area_id: 'VC', to: '0101', descr: '1J24', time: '1' } }], raw, areas);
  assert.equal(raw.berths['VC:0101'], '1J24');
  handleTd([{ CA_MSG: { area_id: 'VC', from: '0101', to: '0103', descr: '1J24', time: '2' } }], raw, areas);
  assert.equal(raw.berths['VC:0101'], undefined);
  assert.equal(raw.berths['VC:0103'], '1J24');
  handleTd([{ CB_MSG: { area_id: 'VC', from: '0103', descr: '1J24', time: '3' } }], raw, areas);
  assert.equal(raw.berths['VC:0103'], undefined);
});

test('CA and CB clear the from berth even if it held a different description', () => {
  const raw = emptyState();
  handleTd([{ CC_MSG: { area_id: 'VC', to: '0101', descr: '1J24' } }, { CC_MSG: { area_id: 'VC', to: '0201', descr: '2T50' } }], raw, areas);
  handleTd([{ CA_MSG: { area_id: 'VC', from: '0101', to: '0103', descr: '1J25' } }, { CB_MSG: { area_id: 'VC', from: '0201', descr: '2T51' } }], raw, areas);
  assert.equal(raw.berths['VC:0101'], undefined);
  assert.equal(raw.berths['VC:0103'], '1J25');
  assert.equal(raw.berths['VC:0201'], undefined);
});

test('heartbeats keep the area marked as reporting', () => {
  const raw = emptyState();
  raw.mode = 'live';
  const t0 = Date.now() - 10 * 60000;
  handleTd([{ CT_MSG: { area_id: 'VC', msg_type: 'CT', report_time: '1249', time: '1' } }], raw, areas, t0);
  assert.equal(buildView(raw).panels[0].quietMins, 10);
  handleTd([{ CT_MSG: { area_id: 'VC', msg_type: 'CT', report_time: '1259', time: '2' } }], raw, areas);
  assert.equal(buildView(raw).panels[0].quietMins, 0);
});

test('TD from other areas is ignored', () => {
  const raw = emptyState();
  const changed = handleTd([{ CA_MSG: { area_id: 'WI', from: '0001', to: '0003', descr: '2W19' } }, { CT_MSG: { area_id: 'VC' } }], raw, areas);
  assert.equal(changed, false);
  assert.deepEqual(raw.berths, {});
});

test('panel berth shows the TRUST delay of the train in it', () => {
  const raw = emptyState();
  handleTd([{ CC_MSG: { area_id: 'VC', to: '0102', descr: '2C38', time: '1' } }], raw, areas);
  handleTrust([{ header: { msg_type: '0003' }, body: { train_id: '722C38MW08', loc_stanox: '12345', event_type: 'DEPARTURE', timetable_variation: '7', variation_status: 'LATE', toc_id: '88' } }], raw, idx);
  const v = buildView(raw);
  const b = v.panels[0].tracks[1].berths[0];
  assert.equal(b.code, '2C38');
  assert.equal(b.delay, 7);
  assert.equal(b.band, 'mid');
  assert.equal(v.panels[0].late[0].code, '2C38');
});

test('TRUST at route stations places the train and colours the section', () => {
  const raw = emptyState();
  const now = Date.now();
  handleTrust([{ header: { msg_type: '0003' }, body: { train_id: '721J24MW08', loc_stanox: '90002', event_type: 'DEPARTURE', direction_ind: 'DOWN', timetable_variation: '12', variation_status: 'LATE' } }], raw, idx, now);
  let r = buildView(raw, now).routes[0];
  assert.equal(r.trains[0].pos, 2.5);
  assert.equal(r.trains[0].dir, 'down');
  assert.equal(r.sections.down[2].band, 'bad');
  // arrives at the next station: direction is worked out from the order of stations
  handleTrust([{ header: { msg_type: '0003' }, body: { train_id: '721J24MW08', loc_stanox: '90003', event_type: 'ARRIVAL', direction_ind: 'UP', timetable_variation: '10', variation_status: 'LATE' } }], raw, idx, now);
  r = buildView(raw, now).routes[0];
  assert.equal(r.trains[0].pos, 3);
  assert.equal(r.trains[0].dir, 'down');
  // the section it just left remembers the delay for a while
  assert.equal(r.sections.down[2].delay, 12);
  assert.equal(r.summary.lateCount, 1);
});

test('a different train with the same headcode elsewhere is ignored', () => {
  const raw = emptyState();
  handleTrust([{ header: { msg_type: '0003' }, body: { train_id: '721J24MW08', loc_stanox: '90001', event_type: 'DEPARTURE', timetable_variation: '0', variation_status: 'ON TIME' } }], raw, idx);
  handleTrust([{ header: { msg_type: '0003' }, body: { train_id: '541J24XX12', loc_stanox: '55555', event_type: 'ARRIVAL', timetable_variation: '30', variation_status: 'LATE' } }], raw, idx);
  assert.equal(raw.trains['1J24'].delay, 0);
});

test('cancellation turns the train red', () => {
  const raw = emptyState();
  handleTd([{ CC_MSG: { area_id: 'VC', to: '0201', descr: '2T50' } }], raw, areas);
  handleTrust([{ header: { msg_type: '0002' }, body: { train_id: '722T50MW08' } }], raw, idx);
  assert.equal(buildView(raw).panels[0].tracks[2].berths[0].band, 'bad');
});

test('summer timestamps lose the extra hour, winter ones are left alone', () => {
  const summer = Date.UTC(2026, 6, 1, 12, 0); // 1 July, 13:00 BST
  assert.equal(trustTime(summer + 3600000), summer);
  const winter = Date.UTC(2026, 10, 8, 12, 0); // 8 Nov, GMT
  assert.equal(trustTime(winter), winter);
});

test('change of identity moves the train to its new headcode', () => {
  const raw = emptyState();
  handleTd([{ CC_MSG: { area_id: 'VC', to: '0101', descr: '1J24' } }], raw, areas);
  handleTrust([{ header: { msg_type: '0003' }, body: { train_id: '721J24MW08', loc_stanox: '12345', event_type: 'ARRIVAL', timetable_variation: '5', variation_status: 'LATE' } }], raw, idx);
  handleTrust([{ header: { msg_type: '0007' }, body: { train_id: '721J24MW08', revised_train_id: '721J99MW08' } }], raw, idx);
  assert.equal(raw.trains['1J24'], undefined);
  assert.equal(raw.trains['1J99'].delay, 5);
  assert.equal(raw.berths['VC:0101'], '1J99');
});

test('SMART extract groups an area\'s berth steps by station', () => {
  const out = extractSmart({ BERTHDATA: [
    { TD: 'VC', FROMBERTH: '0101', TOBERTH: '0103', STANOX: '87201', STANME: 'CLPHMJN', EVENT: 'B', PLATFORM: '13' },
    { TD: 'VC', FROMBERTH: '0103', TOBERTH: '0105', STANOX: '87201', STANME: 'CLPHMJN', EVENT: 'A', PLATFORM: '13' },
    { TD: 'WI', FROMBERTH: '0001', TOBERTH: '0003', STANOX: '1', STANME: 'X' }
  ] }, 'VC');
  assert.equal(out.steps, 2);
  assert.equal(out.stations.CLPHMJN.steps[1].to, '0105');
});

test('S-Class refresh applies on SH, updates change single bytes, signals read on/off', () => {
  const raw = emptyState();
  handleSClass([{ SG_MSG: { area_id: 'VC', address: '00', data: 'FF000000' } }], raw, areas);
  assert.equal((raw.sbits.VC || {})['00'], undefined); // not applied until SH
  handleSClass([{ SH_MSG: { area_id: 'VC', address: '04', data: '01020304' } }], raw, areas);
  assert.equal(raw.sbits.VC['00'], 0xff);
  assert.equal(raw.sbits.VC['07'], 0x04);
  raw.signalMap = { VC: { '0103': { address: '00', bit: 3 } } };
  assert.equal(signalState(raw, 'VC', '0103'), 'off');
  const changes = handleSClass([{ SF_MSG: { area_id: 'VC', address: '00', data: 'F7' } }], raw, areas);
  assert.deepEqual(changes, [{ area: 'VC', key: '00:3', from: 1, to: 0 }]);
  assert.equal(signalState(raw, 'VC', '0103'), 'on');
  assert.equal(signalState(raw, 'VC', '9999'), null);
  assert.equal(buildView(raw).panels[0].tracks[0].berths[1].signal, 'on');
});

test('decoder finds which bit is each berth\'s signal despite noise', () => {
  const raw = emptyState();
  const dec = createDecoder();
  const truth = { '0101': '00:1', '0103': '00:5', '0105': '01:2' };
  raw.sbits = { VC: { '00': 0xff, '01': 0xff, '02': 0xff } };
  let t = 0, seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const flip = (key, to) => {
    const [a, bit] = key.split(':');
    const before = raw.sbits.VC[a];
    const after = to ? before | (1 << bit) : before & ~(1 << bit);
    const ch = handleSClass([{ SF_MSG: { area_id: 'VC', address: a, data: after.toString(16).padStart(2, '0') } }], raw, areas);
    dec.noteChanges(ch, t);
  };
  for (let round = 0; round < 8; round++) {
    for (const [berth, key] of Object.entries(truth)) {
      t += 20000;
      dec.noteStep('VC', berth, t);
      flip(key, 0);                                     // its signal drops to red
      if (rnd() < 0.5) { flip('02:' + Math.floor(rnd() * 8), 0); } // unrelated noise
      dec.settle(t, raw.sbits);
      t += 15000;
      flip(key, 1);                                     // clears again behind the train
      for (let b = 0; b < 8; b++) flip('02:' + b, 1);
      dec.settle(t, raw.sbits);
    }
  }
  dec.settle(t + 60000, raw.sbits);
  const { signals } = dec.results();
  for (const [berth, key] of Object.entries(truth)) {
    const s = signals.VC[berth];
    assert.equal(s.address + ':' + s.bit, key);
  }
});

test('CORPUS extract maps CRS to STANOX', () => {
  const m = extract({ TIPLOCDATA: [{ '3ALPHA': 'VIC', STANOX: '87219', TIPLOC: 'VICTRIC' }, { '3ALPHA': 'VIC', STANOX: '87219', TIPLOC: 'VICTRIE' }, { '3ALPHA': ' ', STANOX: '1' }] }, ['VIC']);
  assert.deepEqual(m, { VIC: ['87219'] });
});

console.log(`\n${passed} tests passed`);
