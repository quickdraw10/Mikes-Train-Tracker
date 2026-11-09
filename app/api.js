// Where the map, boards and area movements come from: the data service when
// it's reachable, otherwise the in-browser demo. Calls wait until app.js has
// decided which.

import { createNationalSim } from './national-sim.js';

let base = null;
let sim = null;
let decide;
const ready = new Promise((r) => { decide = r; });

export function useServer(apiBase) { base = apiBase; decide('server'); }
export function useDemo() {
  if (!sim) { sim = createNationalSim(); setInterval(() => sim.tick(), 10000); }
  decide('demo');
}

async function get(path) {
  const res = await fetch(base + path, { cache: 'no-store' });
  const body = await res.json().catch(() => ({ error: 'The data service sent something unexpected.' }));
  if (!res.ok && !body.error) body.error = 'The data service returned ' + res.status;
  return body;
}

export async function trains(box, max) {
  const how = await ready;
  if (how === 'demo') return sim.trains(box);
  return get(`/api/trains?w=${box.w}&s=${box.s}&e=${box.e}&n=${box.n}${max ? '&max=' + max : ''}`);
}

export async function board(crs, type) {
  const how = await ready;
  if (how === 'demo') return sim.board(crs, type);
  return get(`/api/board/${encodeURIComponent(crs)}?type=${type}`);
}

export async function moves(lat, lon, km = 15) {
  const how = await ready;
  if (how === 'demo') return sim.moves(lat, lon, km);
  return get(`/api/moves?lat=${lat}&lon=${lon}&km=${km}`);
}

export async function train(id) {
  const how = await ready;
  if (how === 'demo') return sim.train(id);
  return get(`/api/train/${encodeURIComponent(id)}`);
}
