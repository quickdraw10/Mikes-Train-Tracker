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
import { YORK, STATION_PANELS } from '../app/layout.js';
import { emptyState, buildView } from '../app/model.js';
import { createSim } from '../app/sim.js';
import { handleTd } from './td.js';
import { handleSClass } from './sclass.js';
import { handleTrust, buildStanoxIndex, prune } from './trust.js';
import { applyStanox, loadStanoxCrs, downloadCorpus, haveCorpus } from './corpus.js';
import { createNational, handleNational, trainsIn, movesNear, pruneNational, attachAll, liveDetailOf, linkPanelTrains, pathOf } from './national.js';
import { staffBoard, loadReasons, reasonsStatus } from './staff.js';
import { createTimetable, loadTimetable } from './timetable.js';
import { downloadSmart, buildStationPanel, smartDebug, smartFind } from './panelbuild.js';
import { createDecoder } from './decode.js';
import { getBoard, serviceDetail } from './ldb.js';
import { createTfl, loadTflStations, pollTfl, pollTflStatus, tflTrainsIn, tflBoard, tflTrain, trackernetAuth, loadTflShapes } from './tfl.js';
import { createIrish, loadStations as loadIrishStations, pollTrains as pollIrish, irishTrainsIn, irishBoard, irishTrain } from './ie.js';
import { BY_CRS } from '../app/geo.js';
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
let ieState = null;
let tflState = null;
let panelDebug = null;
let smartNames = null; // SMART station names / areas / STANOX, for /api/smart-find

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

  // ---- signal panels (York, Clapham Junction, Crewe): layouts from SMART, signals learnt from the feed ----
  const crsStanox = {};
  for (const [sx, crs] of Object.entries(stanoxCrs)) (crsStanox[crs] ||= []).push(sx);
  const areas = new Set([YORK.area]);
  raw.signalMap = {};
  const sigFile = (a) => path.join(here, 'data', `signals-${a}.json`);
  const addArea = (a) => {
    if (!a || raw.signalMap[a]) return;
    areas.add(a);
    raw.signalMap[a] = {};
    try { if (fs.existsSync(sigFile(a))) raw.signalMap[a] = JSON.parse(fs.readFileSync(sigFile(a), 'utf8')).signals || {}; } catch { /* start fresh */ }
  };
  addArea(YORK.area);
  panelDebug = {};
  livePanels = STATION_PANELS.map((cfg) => ({ ...cfg, style: 'iecc', tracks: [], note: `Building the ${cfg.name} layout from Network Rail's berth data…` }));
  const loadPanel = async () => {
    try {
      const smart = await downloadSmart(user, pass);
      smartNames = smartFind(smart, ''); // a small index of names, not the whole file
      livePanels = STATION_PANELS.map((cfg) => {
        const c = { ...cfg, stanox: crsStanox[cfg.crs] || null };
        const built = buildStationPanel(smart, c);
        panelDebug[cfg.id] = { built: built.source, ...smartDebug(smart, c) };
        for (const a of built.areas || []) addArea(a);
        console.log(`[panel] ${cfg.name}: ${built.tracks.length} platform roads, areas ${(built.areas || []).join(',')} from ${built.source.stationRows} SMART rows`);
        return built.tracks.length ? built : { ...built, note: `No platforms for ${cfg.name} found in Network Rail's berth data.` };
      });
      schedulePush();
    } catch (e) {
      console.log('[panel] SMART failed:', e.message, '— retrying in 15 min');
      for (const p of livePanels) p.note = 'Could not download the berth data yet. Retrying shortly.';
      setTimeout(loadPanel, 15 * 60000);
    }
  };
  loadPanel();

  const decoder = createDecoder();
  setInterval(() => {
    const found = decoder.results().signals || {};
    let any = false;
    for (const [a, sigs] of Object.entries(found)) {
      if (!areas.has(a) || !Object.keys(sigs).length) continue;
      raw.signalMap[a] = { ...(raw.signalMap[a] || {}), ...sigs };
      any = true;
      try { fs.mkdirSync(path.dirname(sigFile(a)), { recursive: true }); fs.writeFileSync(sigFile(a), JSON.stringify({ area: a, updated: new Date().toISOString(), signals: raw.signalMap[a] })); } catch { /* disk is optional */ }
    }
    stats.signalsMapped = Object.fromEntries(Object.entries(raw.signalMap).map(([a, m]) => [a, Object.keys(m).length]));
    if (any) schedulePush();
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
  // Darwin's reason code list, for the meaning of delay and cancellation codes
  const reasons = () => loadReasons().then((r) => console.log('[reasons]', r.loaded ? `${r.count} reason codes` : 'not available: ' + JSON.stringify(r.tried)));
  reasons();
  setInterval(reasons, 24 * 3600000);
  // match panel headcodes to real trains (by headcode and place) every few seconds
  setInterval(() => { linkPanelTrains(nat, raw, livePanels || []); }, 5000);
  national = {
    trains: (box, max) => trainsIn(nat, box, Date.now(), max),
    moves: (lat, lon, r) => movesNear(nat, lat, lon, r),
    board: (crs, type) => getBoard(crs, type),
    service: async (crs, type, id) => {
      const st = BY_CRS.get(crs) || { name: crs, crs };
      const d = await serviceDetail(crs, type, id, st);
      // link to the train we're tracking, for its route on the map
      if (!d.error && d.uid) { for (const t of nat.trains.values()) if (t.uid === d.uid && (!d.code || t.code === d.code)) { d.natId = t.id; d.path = pathOf(nat, t); break; } }
      return d;
    },
    train: (id) => liveDetailOf(nat, id)
  };

  // ---- Ireland: Irish Rail's public real-time service ----
  const ie = createIrish();
  ieState = ie;
  const ieStations = () => loadIrishStations(ie).then((n) => console.log(`[ie] ${n} stations`)).catch((e) => { ie.error = e.message; console.log('[ie] stations failed:', e.message); setTimeout(ieStations, 10 * 60000); });
  ieStations();
  setInterval(ieStations, 24 * 3600000);
  const iePoll = () => pollIrish(ie).catch((e) => { ie.error = e.message; });
  iePoll();
  setInterval(iePoll, 30000);
  const gb = national;
  const isIrish = (code) => ie.stations.has(code) || code.length > 3;
  national = {
    ...gb,
    trains: (box, max = 600) => {
      const r = gb.trains(box, max);
      // only ask about Ireland when the view reaches it
      if (box.w > -5.3 || box.s > 55.5 || box.n < 51.3) return r;
      const extra = irishTrainsIn(ie, box);
      const trains = [...r.trains, ...extra].sort((a, b) => (b.delay ?? -99) - (a.delay ?? -99)).slice(0, max);
      return { ...r, total: r.total + extra.length, trains };
    },
    board: (crs, type) => (isIrish(crs) ? irishBoard(ie, crs, type) : gb.board(crs, type)),
    train: (id) => (String(id).startsWith('ie:') ? irishTrain(ie, id) : gb.train(id)),
    service: (crs, type, id) => (isIrish(crs) ? irishTrain(ie, id) : gb.service(crs, type, id))
  };

  // ---- London: TfL (Tube, DLR, Trams) ----
  const tfl = createTfl();
  tflState = tfl;
  const tflShapes = () => loadTflShapes(tfl).then((n) => console.log(`[tfl] ${n} line shapes`)).catch(() => setTimeout(tflShapes, 10 * 60000));
  tflShapes();
  const tflStations = () => loadTflStations(tfl).then((n) => console.log(`[tfl] ${n} stations`)).catch((e) => { tfl.error = e.message; setTimeout(tflStations, 10 * 60000); });
  tflStations().then(() => pollTfl(tfl)).catch(() => {});
  setInterval(tflStations, 24 * 3600000);
  setInterval(() => { if (tfl.byLine.size) pollTfl(tfl).catch((e) => { tfl.error = e.message; }); }, 60000); // TfL caches for about a minute
  const tflStatus = () => pollTflStatus(tfl).catch((e) => { tfl.error = e.message; });
  tflStatus();
  setInterval(tflStatus, 120000);
  const withIe = national;
  national = {
    ...withIe,
    // The main map shows the railway; the London Underground has its own map view (only=tfl)
    trains: (box, max = 600, only) => {
      if (only === 'tfl') { const t = tflTrainsIn(tfl, box); return { mode: 'live', total: t.length, trains: t.slice(0, max) }; }
      return withIe.trains(box, max);
    },
    board: (crs, type) => (tfl.stations.has(crs) ? tflBoard(tfl, crs) : withIe.board(crs, type)),
    train: (id) => (String(id).startsWith('tfl:') ? tflTrain(tfl, id) : withIe.train(id)),
    service: (crs, type, id) => (String(id).startsWith('tfl:') ? tflTrain(tfl, id) : String(id).startsWith('tflp:') ? { error: 'TfL doesn\'t give a train number for this one, so its other stops aren\'t available.' } : withIe.service(crs, type, id))
  };
} else {
  const sim = createSim();
  raw = sim.raw;
  setInterval(() => { sim.tick(); schedulePush(); }, 4000);
  const nsim = createNationalSim();
  setInterval(() => nsim.tick(), 10000);
  national = { trains: (box) => nsim.trains(box), moves: nsim.moves, board: nsim.board, train: nsim.train, service: (crs, type, id) => nsim.service(crs, type, id) };
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
    const max = Math.max(1, Math.min(2500, num('max') || 600));
    return json(200, national.trains(box, max, url.searchParams.get('only') || undefined));
  }
  if (url.pathname === '/api/delays') {
    // Average delay by operator, across every Great Britain train running now with a live report.
    // Early trains count as 0 late; trains with no live delay figure are counted but not averaged.
    const res = national.trains({ w: -8.7, s: 49.8, e: 2.0, n: 61.0 }, 100000);
    const by = new Map();
    for (const t of res.trains || []) {
      if (t.country === 'ie' || t.country === 'tfl' || !t.toc) continue;
      const o = by.get(t.toc) || by.set(t.toc, { name: t.toc, code: t.tocCode || null, trains: 0, timed: 0, sum: 0, onTime: 0, late5: 0, late15: 0, cancelled: 0 }).get(t.toc);
      o.trains++;
      if (t.cancelled) { o.cancelled++; continue; }
      if (typeof t.delay !== 'number') continue;
      const d = Math.max(0, t.delay);
      o.timed++; o.sum += d;
      if (d <= 1) o.onTime++;
      if (d >= 5) o.late5++;
      if (d >= 15) o.late15++;
    }
    const operators = [...by.values()].map(({ sum, ...o }) => ({ ...o, avg: o.timed ? Math.round((sum / o.timed) * 10) / 10 : null }))
      .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.trains - a.trains);
    const all = operators.reduce((m, o) => ({ trains: m.trains + o.trains, timed: m.timed + o.timed, sum: m.sum + (o.avg || 0) * o.timed, late5: m.late5 + o.late5, cancelled: m.cancelled + o.cancelled }), { trains: 0, timed: 0, sum: 0, late5: 0, cancelled: 0 });
    return json(200, { mode: res.mode, at: new Date().toISOString(), overall: { trains: all.trains, timed: all.timed, avg: all.timed ? Math.round((all.sum / all.timed) * 10) / 10 : null, late5: all.late5, cancelled: all.cancelled }, operators });
  }
  if (url.pathname === '/api/moves') {
    const lat = num('lat'), lon = num('lon'), r = Math.min(50, num('km') || 15);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(400, { error: 'Need lat and lon' });
    return json(200, national.moves(lat, lon, r));
  }
  if (url.pathname === '/api/stations-extra') {
    // stations outside Great Britain the app can show (Ireland so far)
    return json(200, { stations: [...(ieState ? ieState.stations.values() : []), ...(tflState ? [...tflState.stations.values()].map(({ lines, ...s }) => ({ ...s, lines, nLines: lines.length })) : [])] });
  }
  if (url.pathname === '/api/ni-raw') {
    // Fetch Translink's open data (or its Worldline backup) as the server sees it, to
    // check the format. Only these two sites, read-only, first 20,000 characters.
    const want = url.searchParams.get('u') || 'https://apis.opendatani.gov.uk/translink/';
    let target;
    try { target = new URL(want); } catch { return json(400, { error: 'Bad address' }); }
    if (!['apis.opendatani.gov.uk', 'tiger.worldline.global', 'tiger-api-portal.worldline.global'].includes(target.hostname)) return json(400, { error: 'Only Translink open data addresses' });
    fetch(target, { headers: { 'user-agent': 'MikesTrainTracker/1.0' }, signal: AbortSignal.timeout(15000) })
      .then(async (r) => {
        const text = await r.text();
        const out = { url: target.href, status: r.status, type: r.headers.get('content-type'), cached: r.headers.get('x-cached'), length: text.length };
        // grep: the snippets around a pattern, for finding the data addresses inside a big script
        const g = url.searchParams.get('grep');
        if (g) {
          const re = new RegExp(g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\|/g, '|'), 'gi');
          const hits = [];
          let m;
          while ((m = re.exec(text)) && hits.length < 30) hits.push(text.slice(Math.max(0, m.index - 60), m.index + 90));
          out.hits = hits;
        } else out.body = text.slice(0, 20000);
        json(200, out);
      })
      .catch((e) => json(200, { url: target.href, error: e.message }));
    return;
  }
  if (url.pathname === '/api/ni-probe') {
    // Find how Worldline's NI Railways site gets its data: the API addresses inside its
    // app, and what a few likely ones return. Read-only, Worldline's public site only.
    (async () => {
      const get = async (u, accept = 'application/json') => {
        try {
          const r = await fetch(u, { headers: { accept, origin: 'https://tiger.worldline.global', 'user-agent': 'Mozilla/5.0 MikesTrainTracker' }, signal: AbortSignal.timeout(10000) });
          const t = await r.text();
          return { url: u, status: r.status, type: r.headers.get('content-type'), body: t.slice(0, 1500) };
        } catch (e) { return { url: u, error: e.message }; }
      };
      const shell = await get('https://tiger.worldline.global/toc/NIR', 'text/html');
      const main = /src="(main\.[^"]+\.js)"/.exec(shell.body || '');
      let strings = [];
      if (main) {
        try {
          const js = await (await fetch('https://tiger.worldline.global/' + main[1], { signal: AbortSignal.timeout(10000) })).text();
          const found = new Set();
          for (const m of js.matchAll(/["'`]([^"'`\s]{0,80}(?:tiger-api|\/services|\/toc|\/stations?|\/api\/)[^"'`\s]{0,80})["'`]/g)) found.add(m[1]);
          strings = [...found].slice(0, 60);
        } catch (e) { strings = ['error: ' + e.message]; }
      }
      const tries = await Promise.all([
        'https://tiger-api-portal.worldline.global/toc/NIR',
        'https://tiger-api-portal.worldline.global/tocs/NIR',
        'https://tiger-api-portal.worldline.global/stations/NIR',
        'https://tiger-api-portal.worldline.global/toc/NIR/stations',
        'https://tiger-api-portal.worldline.global/services/BELFASTC',
        'https://tiger-api-portal.worldline.global/services/LEYTNMR'
      ].map((u) => get(u)));
      json(200, { main: main ? main[1] : null, strings, tries });
    })().catch((e) => json(200, { error: e.message }));
    return;
  }
  if (url.pathname === '/api/tfl-lines') return json(200, { lines: tflState && tflState.shapes ? Object.values(tflState.shapes) : [] });
  if (url.pathname === '/api/tfl-status') return json(200, { lines: tflState ? tflState.status : [] });
  if (url.pathname === '/api/tfl-debug') return json(200, tflState ? { stations: tflState.stations.size, lines: tflState.byLine.size, trains: tflState.trains.size, viaTrackernet: [...tflState.trains.values()].filter((t) => t.source === 'trackernet').length, at: tflState.at ? new Date(tflState.at).toISOString() : null, key: Boolean(process.env.TFL_KEY), trackernetKey: process.env.TFL_TRACKERNET_KEY ? 'own key' : 'using main key', trackernetAuth: trackernetAuth(), shapes: Object.keys(tflState.shapes || {}).length, byLine: [...tflState.trains.values()].reduce((m, t) => ((m[t.line] = (m[t.line] || 0) + 1), m), {}), error: tflState.error, status: tflState.status.slice(0, 4), sample: [...tflState.trains.values()].slice(0, 4).map(({ stops, ...t }) => ({ ...t, stops: stops ? stops.length : null })) } : { note: 'Not running (demo mode)' });
  if (url.pathname === '/api/ie-debug') return json(200, ieState ? { trains: ieState.trains.size, stations: ieState.stations.size, at: ieState.at ? new Date(ieState.at).toISOString() : null, error: ieState.error, sample: [...ieState.trains.values()].slice(0, 3) } : { note: 'Not running (demo mode)' });
  const tm = /^\/api\/train\/([A-Za-z0-9:% -]{4,48})$/.exec(decodeURIComponent(url.pathname));
  if (tm) {
    Promise.resolve(national.train(tm[1])).then((d) => json(200, d || { error: 'Unknown train' })).catch((e) => json(500, { error: e.message }));
    return;
  }
  const sd = /^\/api\/staff-debug\/([A-Za-z]{3})$/.exec(url.pathname);
  if (sd) {
    staffBoard(sd[1].toUpperCase(), { raw: true })
      .then((b) => { const svcs = (b && b.trainServices) || []; json(200, { ...b, trainServices: svcs.slice(0, 2), servicesShown: Math.min(2, svcs.length), servicesTotal: svcs.length }); })
      .catch((e) => json(500, { error: e.message }));
    return;
  }
  if (url.pathname === '/api/reasons-debug') return json(200, reasonsStatus());
  if (url.pathname === '/api/smart-find') {
    // how a station appears in Network Rail's SMART berth data, e.g. ?q=HULL
    if (!smartNames) return json(200, { note: 'SMART not loaded yet (or demo mode)' });
    const q = (url.searchParams.get('q') || '').toUpperCase().trim();
    return json(200, { q, matches: smartNames.filter((m) => !q || m.stanme.toUpperCase().includes(q) || m.stanox === q).slice(0, 40) });
  }
  if (url.pathname === '/api/panel-debug') {
    if (!panelDebug) return json(200, { note: 'Demo mode' });
    const id = url.searchParams.get('id');
    if (id) return json(200, panelDebug[id] || { note: 'Still loading SMART, or no such panel. Panels: ' + STATION_PANELS.map((p) => p.id).join(', ') });
    return json(200, Object.fromEntries(Object.entries(panelDebug).map(([k, v]) => [k, { areas: v.areas, stationRows: v.stationRows, built: v.built, more: `/api/panel-debug?id=${k}` }])));
  }
  const sv = /^\/api\/service\/([A-Za-z0-9]{3,14})$/.exec(url.pathname);
  if (sv) {
    const type = url.searchParams.get('type') === 'arr' ? 'arr' : 'dep';
    Promise.resolve(national.service(sv[1].toUpperCase(), type, url.searchParams.get('id') || ''))
      .then((d) => json(200, d)).catch((e) => json(502, { error: e.message }));
    return;
  }
  const bm = /^\/api\/board\/([A-Za-z0-9]{3,14})$/.exec(url.pathname);
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
    // no-cache: phones check for a newer version each time, so updates show straight away
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Train tracker on http://localhost:${PORT} (${raw.mode} mode)`));
