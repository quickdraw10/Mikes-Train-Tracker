// Berth map from Network Rail's SMART reference file. SMART lists, for each
// TD area, which berths trains step between and which station (STANOX) and
// platform each step belongs to. That gives us the real panel layout without
// waiting for trains, and later lets the street and network maps place trains
// at stations from TD alone.
//
//   npm run smart -- VC        (needs NR_USER and NR_PASS)
//
// Output: data/smart-<AREA>.json — the steps for that area, grouped by station.

import './env.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const URL_SMART = process.env.NR_SMART_URL || 'https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=SMART';

export function extractArea(smart, area) {
  const steps = (smart.BERTHDATA || []).filter((r) => (r.TD || '').trim() === area);
  const byStation = {};
  for (const r of steps) {
    const key = (r.STANME || '').trim() || 'unknown';
    (byStation[key] ||= { stanox: String(r.STANOX || '').trim(), steps: [] }).steps.push({
      from: (r.FROMBERTH || '').trim(), to: (r.TOBERTH || '').trim(),
      event: (r.EVENT || '').trim(), platform: (r.PLATFORM || '').trim(),
      fromLine: (r.FROMLINE || '').trim(), toLine: (r.TOLINE || '').trim(),
      offset: Number(r.BERTHOFFSET) || 0
    });
  }
  return { area, steps: steps.length, stations: byStation };
}

async function main() {
  const area = (process.argv[2] || 'VC').toUpperCase();
  const { NR_USER: user, NR_PASS: pass } = process.env;
  if (!user || !pass) { console.error('Set NR_USER and NR_PASS first.'); process.exit(1); }
  console.log('Downloading SMART…');
  const res = await fetch(URL_SMART, { headers: { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') }, redirect: 'follow' });
  if (!res.ok) { console.error('Download failed:', res.status, res.statusText); process.exit(1); }
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const out = extractArea(JSON.parse(buf.toString('utf8')), area);
  const file = path.join(here, 'data', `smart-${area}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Area ${area}: ${out.steps} berth steps at ${Object.keys(out.stations).length} locations. Saved to ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
