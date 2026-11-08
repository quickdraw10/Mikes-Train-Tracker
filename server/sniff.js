// Berth sniffer: listens to one TD area for a while and writes down which
// berths trains step between, so we can lay out the real panel.
//
//   npm run sniff -- VC 15      (area VC for 15 minutes; needs NR_USER and NR_PASS)
//
// Output: data/berths-<AREA>.json — every berth seen, how often, which
// berths it leads to, and sample headcodes. Chains of berths that trains
// step along are the tracks we draw on the panel.

import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectFeeds } from './feeds.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const area = (process.argv[2] || 'VC').toUpperCase();
const minutes = Number(process.argv[3] || 15);
const { NR_USER: user, NR_PASS: pass } = process.env;
if (!user || !pass) { console.error('Set NR_USER and NR_PASS first.'); process.exit(1); }

const berths = {};
function note(id) { return (berths[id] ||= { id, count: 0, next: {}, headcodes: [] }); }

const stop = connectFeeds({
  user, pass, topics: ['td'],
  onMessage: (_, batch) => {
    for (const item of batch) {
      const m = item.CA_MSG || item.CC_MSG;
      if (!m || m.area_id !== area) continue;
      const to = note(m.to);
      to.count++;
      if (to.headcodes.length < 8 && !to.headcodes.includes(m.descr)) to.headcodes.push(m.descr);
      if (item.CA_MSG) { const from = note(m.from); from.next[m.to] = (from.next[m.to] || 0) + 1; }
    }
  }
});

console.log(`Listening to TD area ${area} for ${minutes} min…`);
setTimeout(() => {
  const file = path.join(here, 'data', `berths-${area}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const list = Object.values(berths).sort((a, b) => b.count - a.count);
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  console.log(`Saw ${list.length} berths. Saved to ${file}`);
  stop();
  process.exit(0);
}, minutes * 60 * 1000);
