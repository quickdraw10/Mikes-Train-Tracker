// Builds app/stations.js from the open UK station list
// (github.com/davwheat/uk-railway-stations, ODbL licence).
//   git clone --depth 1 https://github.com/davwheat/uk-railway-stations /tmp/ukstations
//   node scripts/build-stations.mjs /tmp/ukstations/stations.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/build-stations.mjs path/to/stations.json'); process.exit(1); }
const list = JSON.parse(fs.readFileSync(src, 'utf8'))
  .filter((s) => s.crsCode && Number.isFinite(s.lat) && Number.isFinite(s.long))
  .map((s) => [s.crsCode, s.stationName, Math.round(s.lat * 1e5) / 1e5, Math.round(s.long * 1e5) / 1e5])
  .sort((a, b) => a[1].localeCompare(b[1]));

const out = `// All National Rail stations: [CRS code, name, latitude, longitude].
// Built by scripts/build-stations.mjs from github.com/davwheat/uk-railway-stations
// (Open Database License, ODbL). ${list.length} stations.
export const STATIONS = ${JSON.stringify(list)};
`;
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'stations.js');
fs.writeFileSync(file, out);
console.log('Wrote', list.length, 'stations to', file, (out.length / 1024).toFixed(0) + ' KB');
