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
import { YORK } from '../app/layout.js';
import { emptyState, buildView } from '../app/model.js';
import { createSim } from '../app/sim.js';
import { handleTd } from './td.js';
import { handleSClass } from './sclass.js';
import { handleTrust, buildStanoxIndex, prune } from './trust.js';
import { applyStanox, loadStanoxCrs, downloadCorpus, haveCorpus } from './corpus.js';
import { createNational, handleNational, trainsIn, movesNear, pruneNational, attachAll, detailOf } from './national.js';
import { createTimetable, loadTimetable } from './timetable.js';
import { downloadSmart, buildStationPanel, smartDebug } from './panelbuild.js';
import { createDecoder } from './decode.js';
import { getBoard } from './ldb.js';
import { createNationalSim } from '../app/national-sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(here, '..', 'app');
const PORT = Number(process.env.PORT || 8080);
const { NR_USER: user, NR_PASS: pass } = process.env;
const live = Boolean(user && pass);

let raw;
let national; // the map, station boards and area movements
let stats = { td: 0, trust: 0, lastTd: null, lastTrust: null, started: Date.now() };

let livePanels = null; // panel layouts built from SMART (live only)
let panelDebug = null;

if (live) {
  raw = emptyState();
  raw.mode = 'live';
  // Hosts like Railway start each deploy with a fresh disk, so fetch station codes when missing
  if (!haveCorpus()) {
    try { await downloadCorpus(user, pass); } catch (e) { console.log('[corpus] could not download:', e.message); }
  }
  applyStanox();
  const stanoxIndex = buildStanoxIndex();
  const stanoxCrs = loadStanoxCrs();
  const tt = createTimetable();
  const nat = createNational(tt);

  // ---- York panel: layout from SMART, signals learnt from the feed ----
  const areas = new Set([YORK.area]);
  livePanels = [{ ...YORK, style: 'iecc', tracks: [], note: 'Building the York layout from Network Rail\'s berth data…' }];
  const loadPanel = async () => {
    try {
      const smart = await downloadSmart(user, pass);
      const built = buildStationPanel(smart, YORK);
      panelDebug = { built: built.source, ...smartDebug(smart, YORK) };
      livePanels = [built.tracks.length ? built : { ...built, note: `No platforms for ${YORK.name} found in SMART area ${YORK.area}.` }];
      console.log(`[panel] ${YORK.name}: ${built.tracks.length} platform roads from ${built.source.stationRows} SMART rows`);
      schedulePush();
    } catch (e) {
      console.log('[panel] SMART failed:', e.message, '— retrying in 15 min');
      livePanels[0].note = 'Could not download the berth data yet. Retrying shortly.';
      setTimeout(loadPanel, 15 * 60000);
    }
  };
  loadPanel();

  raw.signalMap = {};
  const sigFile = path.join(here, 'data', `signals-${YORK.area}.json`);
  if (fs.existsSync(sigFile)) raw.signalMap[YORK.area] = JSON.parse(fs.readFileSync(sigFile, 'utf8')).signals || {};
  const decoder = createDecoder();
  setInterval(() => {
    const found = (decoder.results().signals || {})[YORK.area] || {};
    if (!Object.keys(found).length) return;
    raw.signalMap[YORK.area] = { ...(raw.signalMap[YORK.area] || {}), ...found };
    stats.signalsMapped = Object.keys(raw.signalMap[YORK.area]).length;
    try { fs.mkdirSync(path.dirname(sigFile), { recursive: true }); fs.writeFileSync(sigFile, JSON.stringify({ area: YORK.area, updated: new Date().toISOString(), signals: raw.signalMap[YORK.area] })); } catch { /* disk is optional */ }
    schedulePush();
  }, 5 * 60000);

  // ---- timetable: load now, then each morning after the new file is out (~06:00) ----
  const loadTt = async () => {
    try { await loadTimetable(tt, { user, pass }); attachAll(nat); stats.timetable = { schedules: tt.schedules, dates: tt.dates }; }
    catch (e) { console.log('[timetable] failed:', e.message, '— retrying in 30 min'); setTimeout(loadTt, 30 * 60000); }
  };
  loadTt();
  setInterval(() => { const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date())); if (h === 6 && Date.now() - (tt.loadedAt || 0) > 12 * 3600000) loadTt(); }, 10 * 60000);

  const { connectFeeds } = await import('./feeds.js');
  connectFeeds({
    user, pass,
    onMessage: (topic, batch) => {
      const now = Date.now();
      let changed = false;
      if (topic === 'td') {
        stats.td += batch.length; stats.lastTd = now;
        changed = handleTd(batch, raw, areas);
        for (const item of batch) { const m = item.CA_MSG; if (m && areas.has(m.area_id)) decoder.noteStep(m.area_id, m.from, now); }
        const sChanges = handleSClass(batch, raw, areas);
        if (sChanges.length) { decoder.noteChanges(sChanges, now); changed = true; }
        decoder.settle(now, raw.sbits);
      } else {
        stats.trust += batch.length; stats.lastTrust = now;
        changed = handleTrust(batch, raw, stanoxIndex, now);
        handleNational(batch, nat, stanoxCrs, now);
      }
      if (changed) { raw.updated = now; schedulePush(); }
    }
  });
  setInterval(() => { prune(raw); pruneNational(nat); }, 10 * 60 * 1000);
  national = {
    trains: (box) => trainsIn(nat, box),
    moves: (lat, lon, r) => movesNear(nat, lat, lon, r),
    board: (crs, type) => getBoard(crs, type),
    train: (id) => detailOf(nat, id)
  };
} else {
  const sim = createSim();
  raw = sim.raw;
  setInterval(() => { sim.tick(); schedulePush(); }, 4000);
  const nsim = createNationalSim();
  setInterval(() => nsim.tick(), 10000);
  national = { trains: nsim.trains, moves: nsim.moves, board: nsim.board, train: nsim.train };
  console.log('No NR_USER / NR_PASS set — running on demo trains.');
}

// ---- live updates to connected phones ----
const view = () => buildView(raw, Date.now(), livePanels || undefined);
const clients = new Set();
let pushTimer = null;
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const data = 'data: ' + JSON.stringify(view()) + '\n\n';
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
    return res.end(JSON.stringify(view()));
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\ndata: ' + JSON.stringify(view()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const num = (k) => Number(url.searchParams.get(k));
  if (url.pathname === '/api/trains') {
    const box = { w: num('w'), s: num('s'), e: num('e'), n: num('n') };
    if (![box.w, box.s, box.e, box.n].every(Number.isFinite)) return json(400, { error: 'Need w, s, e, n' });
    return json(200, national.trains(box));
  }
  if (url.pathname === '/api/moves') {
    const lat = num('lat'), lon = num('lon'), r = Math.min(50, num('km') || 15);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(400, { error: 'Need lat and lon' });
    return json(200, national.moves(lat, lon, r));
  }
  const tm = /^\/api\/train\/([A-Za-z0-9]{4,12})$/.exec(url.pathname);
  if (tm) return json(200, national.train(tm[1]) || { error: 'Unknown train' });
  if (url.pathname === '/api/panel-debug') return json(200, panelDebug || { note: live ? 'Still loading SMART' : 'Demo mode' });
  const bm = /^\/api\/board\/([A-Za-z]{3})$/.exec(url.pathname);
  if (bm) {
    const type = url.searchParams.get('type') === 'arr' ? 'arr' : 'dep';
    Promise.resolve(national.board(bm[1].toUpperCase(), type))
      .then((b) => json(b.error ? (b.needsKey ? 503 : 502) : 200, b))
      .catch((e) => json(502, { error: 'Could not reach National Rail: ' + e.message }));
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
