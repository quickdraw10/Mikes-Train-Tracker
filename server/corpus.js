// Station codes. The movement feed names locations by STANOX number;
// the route config uses everyday 3-letter CRS codes. This downloads
// Network Rail's CORPUS reference file once and saves a small
// CRS -> STANOX lookup in data/stanox.json.
//
//   npm run corpus        (needs NR_USER and NR_PASS)

import './env.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../app/layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, 'data', 'stanox.json');
const URL_CORPUS = process.env.NR_CORPUS_URL || 'https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=CORPUS';

// Puts the saved STANOX codes onto the route stations. Returns how many stations are matched.
export function applyStanox(log = console.log) {
  if (!fs.existsSync(FILE)) {
    log('[corpus] no data/stanox.json yet — route view will stay empty in live mode. Run: npm run corpus');
    return 0;
  }
  const map = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  let n = 0;
  for (const r of ROUTES) for (const s of r.stations) {
    if (map[s.crs]) { s.stanox = map[s.crs]; n++; }
    else log('[corpus] no STANOX found for', s.crs, s.name);
  }
  return n;
}

export const ALL_FILE = path.join(here, 'data', 'stanox-crs.json');

export function stanoxToCrs(corpus) {
  const out = {};
  for (const row of corpus.TIPLOCDATA || []) {
    const crs = (row['3ALPHA'] || '').trim();
    const stanox = String(row.STANOX || '').trim();
    if (crs && stanox && !out[stanox]) out[stanox] = crs;
  }
  return out;
}

export function loadStanoxCrs(log = console.log) {
  if (!fs.existsSync(ALL_FILE)) { log('[corpus] no data/stanox-crs.json yet — the map will stay empty in live mode. Run: npm run corpus'); return {}; }
  return JSON.parse(fs.readFileSync(ALL_FILE, 'utf8'));
}

export function extract(corpus, crsList) {
  const want = new Set(crsList);
  const out = {};
  for (const row of corpus.TIPLOCDATA || []) {
    const crs = (row['3ALPHA'] || '').trim();
    const stanox = String(row.STANOX || '').trim();
    if (!want.has(crs) || !stanox) continue;
    (out[crs] ||= []);
    if (!out[crs].includes(stanox)) out[crs].push(stanox);
  }
  return out;
}

async function main() {
  const { NR_USER: user, NR_PASS: pass } = process.env;
  if (!user || !pass) { console.error('Set NR_USER and NR_PASS (your Network Rail data feeds login) first.'); process.exit(1); }
  console.log('Downloading CORPUS…');
  const res = await fetch(URL_CORPUS, { headers: { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') }, redirect: 'follow' });
  if (!res.ok) { console.error('Download failed:', res.status, res.statusText); process.exit(1); }
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const corpus = JSON.parse(buf.toString('utf8'));
  const crs = ROUTES.flatMap((r) => r.stations.map((s) => s.crs));
  const map = extract(corpus, crs);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
  console.log('Saved', Object.keys(map).length, 'of', crs.length, 'route stations to', FILE);
  // Every STANOX that is a passenger station, for placing trains on the map
  const all = stanoxToCrs(corpus);
  fs.writeFileSync(ALL_FILE, JSON.stringify(all));
  console.log('Saved', Object.keys(all).length, 'station STANOX codes to', ALL_FILE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
