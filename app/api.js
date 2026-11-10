// Where the map, boards and area movements come from: the data service when
// it's reachable, otherwise the in-browser demo. Calls wait until app.js has
// decided which.

import { createNationalSim } from './national-sim.js';

let base = null;
let sim = null;
let mode = null; // 'server' | 'demo' | 'offline'
let decide;
const ready = new Promise((r) => { decide = r; });
const set = (m) => { mode = m; decide(m); };

export function useServer(apiBase) { base = apiBase; set('server'); }
export function useDemo() {
  if (!sim) { sim = createNationalSim(); setInterval(() => sim.tick(), 10000); }
  set('demo');
}
// The live service can't be reached: say so, never show invented trains instead
export function useOffline(apiBase) { base = apiBase; set('offline'); }
export const OFFLINE = { error: 'Can\'t reach the live data right now. It will reconnect automatically.', offline: true };

async function get(path) {
  const res = await fetch(base + path, { cache: 'no-store' });
  const body = await res.json().catch(() => ({ error: 'The data service sent something unexpected.' }));
  if (!res.ok && !body.error) body.error = 'The data service returned ' + res.status;
  return body;
}

// only: 'tfl' for the London Underground map view
export async function trains(box, max, only) {
  await ready;
  if (mode === 'offline') return { ...OFFLINE };
  if (mode === 'demo') return only ? { mode: 'demo', total: 0, trains: [] } : sim.trains(box);
  return get(`/api/trains?w=${box.w}&s=${box.s}&e=${box.e}&n=${box.n}${max ? '&max=' + max : ''}${only ? '&only=' + only : ''}`);
}

export async function board(crs, type) {
  await ready;
  if (mode === 'offline') return { ...OFFLINE };
  if (mode === 'demo') return sim.board(crs, type);
  return get(`/api/board/${encodeURIComponent(crs)}?type=${type}`);
}

export async function moves(lat, lon, km = 15) {
  await ready;
  if (mode === 'offline') return { ...OFFLINE };
  if (mode === 'demo') return sim.moves(lat, lon, km);
  return get(`/api/moves?lat=${lat}&lon=${lon}&km=${km}`);
}

export async function train(id) {
  await ready;
  if (mode === 'offline') return { ...OFFLINE };
  if (mode === 'demo') return sim.train(id);
  return get(`/api/train/${encodeURIComponent(id)}`);
}

// One train from a station board (National Rail's own record of its calls)
export async function service(crs, type, id) {
  await ready;
  if (mode === 'offline') return { ...OFFLINE };
  if (mode === 'demo') return sim.service(crs, type, id);
  return get(`/api/service/${encodeURIComponent(crs)}?type=${type}&id=${encodeURIComponent(id)}`);
}

// Stations outside Great Britain the live service covers
export async function extraStations() {
  await ready;
  if (mode !== 'server') return [];
  const r = await get('/api/stations-extra').catch(() => null);
  return (r && r.stations) || [];
}

// London line status (TfL)
export async function tflStatus() {
  await ready;
  if (mode !== 'server') return null;
  return get('/api/tfl-status').catch(() => null);
}
