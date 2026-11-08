// Signal decoder: listens to one TD area and works out which S-Class bit is
// each berth's signal (see decode.js for how).
//
//   npm run signals -- VC 60     (area VC for 60 minutes; needs NR_USER and NR_PASS)
//
// Saves data/signals-<AREA>.json, which the data service loads to show signals
// as on or off. Busy berths are decoded within an hour; rarely used signals can
// take days, so it is fine to run this again later: it adds to what it found.
// The full evidence goes in data/signals-<AREA>-report.json.

import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectFeeds } from './feeds.js';
import { handleSClass } from './sclass.js';
import { createDecoder } from './decode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const area = (process.argv[2] || 'VC').toUpperCase();
const minutes = Number(process.argv[3] || 60);
const { NR_USER: user, NR_PASS: pass } = process.env;
if (!user || !pass) { console.error('Set NR_USER and NR_PASS first.'); process.exit(1); }

const raw = {};
const areas = new Set([area]);
const dec = createDecoder();
let sMessages = 0, caMessages = 0;

const stop = connectFeeds({
  user, pass, topics: ['td'],
  onMessage: (_, batch) => {
    const now = Date.now();
    for (const item of batch) {
      const m = item.CA_MSG;
      if (m && m.area_id === area) { dec.noteStep(area, m.from, now); caMessages++; }
      if ((item.SF_MSG || item.SG_MSG || item.SH_MSG || {}).area_id === area) sMessages++;
    }
    dec.noteChanges(handleSClass(batch, raw, areas), now);
    dec.settle(now, raw.sbits);
  }
});

console.log(`Decoding signals in TD area ${area} for ${minutes} min…`);
const tick = setInterval(() => {
  const { signals } = dec.results();
  console.log(`  ${caMessages} berth steps, ${sMessages} signalling messages, ${Object.keys(signals[area] || {}).length} signals decoded so far`);
  if (caMessages > 50 && sMessages === 0) console.log(`  Area ${area} is not sending signalling (S-Class) data, so its signals cannot be shown.`);
}, 60000);

setTimeout(() => {
  clearInterval(tick);
  dec.settle(Date.now() + 60000, raw.sbits);
  const { signals, report } = dec.results();
  const file = path.join(here, 'data', `signals-${area}.json`);
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).signals || {} : {};
  const merged = { ...old, ...(signals[area] || {}) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ area, updated: new Date().toISOString(), signals: merged }, null, 2));
  fs.writeFileSync(path.join(here, 'data', `signals-${area}-report.json`), JSON.stringify(report, null, 2));
  console.log(`Decoded ${Object.keys(signals[area] || {}).length} signals this run (${Object.keys(merged).length} in total). Saved to ${file}`);
  stop();
  process.exit(0);
}, minutes * 60 * 1000);
