// The data service. Listens to the signalling (TD) and movement (TRUST)
// feeds, keeps the current picture in memory, and streams it to the app.
//
//   GET /api/view     the current picture (JSON)
//   GET /api/stream   live updates (Server-Sent Events)
//   GET /api/health   status
//   anything else     the app itself (files in ../app)
//
// With NR_USER and NR_PASS set it runs live; without them it runs on demo trains.

import './env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANELS } from '../app/layout.js';
import { emptyState, buildView } from '../app/model.js';
import { createSim } from '../app/sim.js';
import { handleTd } from './td.js';
import { handleSClass } from './sclass.js';
import { handleTrust, buildStanoxIndex, prune } from './trust.js';
import { applyStanox } from './corpus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(here, '..', 'app');
const PORT = Number(process.env.PORT || 8080);
const { NR_USER: user, NR_PASS: pass } = process.env;
const live = Boolean(user && pass);

let raw;
let stats = { td: 0, trust: 0, lastTd: null, lastTrust: null, started: Date.now() };

if (live) {
  raw = emptyState();
  raw.mode = 'live';
  applyStanox();
  const stanoxIndex = buildStanoxIndex();
  const areas = new Set(PANELS.map((p) => p.area));
  raw.signalMap = {};
  for (const a of areas) {
    const f = path.join(here, 'data', `signals-${a}.json`);
    if (fs.existsSync(f)) {
      raw.signalMap[a] = JSON.parse(fs.readFileSync(f, 'utf8')).signals || {};
      console.log(`[signals] ${Object.keys(raw.signalMap[a]).length} signals mapped in area ${a}`);
    } else console.log(`[signals] no data/signals-${a}.json yet — signals show as unknown. Run: npm run signals -- ${a}`);
  }
  const { connectFeeds } = await import('./feeds.js');
  connectFeeds({
    user, pass,
    onMessage: (topic, batch) => {
      const now = Date.now();
      let changed = false;
      if (topic === 'td') {
        stats.td += batch.length; stats.lastTd = now;
        changed = handleTd(batch, raw, areas);
        const sBefore = JSON.stringify(raw.sbits);
        handleSClass(batch, raw, areas);
        if (JSON.stringify(raw.sbits) !== sBefore) changed = true;
      }
      else { stats.trust += batch.length; stats.lastTrust = now; changed = handleTrust(batch, raw, stanoxIndex, now); }
      if (changed) { raw.updated = now; schedulePush(); }
    }
  });
  setInterval(() => prune(raw), 10 * 60 * 1000);
} else {
  const sim = createSim();
  raw = sim.raw;
  setInterval(() => { sim.tick(); schedulePush(); }, 4000);
  console.log('No NR_USER / NR_PASS set — running on demo trains.');
}

// ---- live updates to connected phones ----
const clients = new Set();
let pushTimer = null;
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const data = 'data: ' + JSON.stringify(buildView(raw)) + '\n\n';
    for (const res of clients) res.write(data);
  }, 1000);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

// ---- http ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  cors(res);
  if (url.pathname === '/api/view') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(buildView(raw)));
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\ndata: ' + JSON.stringify(buildView(raw)) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mode: raw.mode, trains: Object.keys(raw.trains).length, berths: Object.keys(raw.berths).length, clients: clients.size, ...stats }));
  }
  // static app files
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const file = path.join(APP_DIR, p);
  if (!file.startsWith(APP_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Train tracker on http://localhost:${PORT} (${raw.mode} mode)`));
