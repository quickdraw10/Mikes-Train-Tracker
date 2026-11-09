// Demo data: invented trains that step through the panel berths and along
// the route, so the app works before the live feed login is set up.
// It writes the same "raw" state the live feeds do.

import { PANELS, ROUTES } from './layout.js';
import { emptyState, train } from './model.js';

const DOWN_DESC = ['London King\'s Cross → Edinburgh', 'Leeds → Scarborough', 'Manchester Airport → Newcastle', 'Plymouth → Edinburgh', 'Hull → Scarborough', 'London King\'s Cross → Newcastle'];
const UP_DESC = ['Edinburgh → London King\'s Cross', 'Scarborough → Leeds', 'Newcastle → Manchester Airport', 'Aberdeen → Plymouth', 'Harrogate → Leeds', 'Newcastle → Birmingham New Street'];
const PREFIX = ['1S', '1E', '1N', '2C', '1P', '2H', '1V', '2R'];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function randomDelay() {
  const r = Math.random();
  if (r < 0.6) return Math.random() < 0.5 ? 0 : 1;
  if (r < 0.9) return 2 + Math.floor(Math.random() * 8);
  return 10 + Math.floor(Math.random() * 13);
}

export function createSim() {
  const raw = emptyState();
  raw.mode = 'demo';
  const used = new Set();
  function newCode() {
    let c;
    do { c = pick(PREFIX) + String(Math.floor(Math.random() * 100)).padStart(2, '0'); } while (used.has(c));
    used.add(c);
    return c;
  }
  function newTrain(dir) {
    const code = newCode();
    const t = train(raw, code);
    t.delay = randomDelay();
    t.desc = pick(dir === 'down' ? DOWN_DESC : UP_DESC);
    t.toc = pick(['LNER', 'TransPennine Express', 'Northern', 'CrossCountry', 'Grand Central']);
    return t;
  }
  function retire(code) {
    delete raw.trains[code];
    used.delete(code);
  }

  // Panel trains: track -> list of { code, i }
  const panelTrains = {};
  // Route trains: list of { code, routeId }
  const routeTrains = [];

  function tick(now = Date.now()) {
    for (const p of PANELS) {
      for (const tr of p.tracks) {
        const key = p.id + ':' + tr.name;
        const list = (panelTrains[key] ||= []);
        // Berth ids in the order this road's trains travel through them
        const ids = tr.berths.map((b) => (typeof b === 'string' ? b : b.id));
        const order = tr.dir === 'up' ? [...ids].reverse() : ids;
        const n = order.length;
        // move front trains first so they free the berth behind
        list.sort((a, b) => b.i - a.i);
        for (const pt of [...list]) {
          if (Math.random() > 0.45) continue;
          const next = pt.i + 1;
          delete raw.berths[p.area + ':' + order[pt.i]];
          if (next >= n) { list.splice(list.indexOf(pt), 1); retire(pt.code); continue; }
          if (list.some((o) => o.i === next)) { raw.berths[p.area + ':' + order[pt.i]] = pt.code; continue; }
          pt.i = next;
          raw.berths[p.area + ':' + order[pt.i]] = pt.code;
        }
        if (!list.some((o) => o.i <= 1) && list.length < 3 && Math.random() < 0.3) {
          const t = newTrain(tr.dir);
          list.push({ code: t.code, i: 0 });
          raw.berths[p.area + ':' + order[0]] = t.code;
        }
        // Automatic signals: each berth's signal is on (red) while the berth beyond it is occupied
        raw.signals ||= {};
        order.forEach((b, i) => {
          const ahead = order[i + 1];
          raw.signals[p.area + ':' + b] = ahead && raw.berths[p.area + ':' + ahead] ? 'on' : 'off';
        });
      }
    }

    for (const r of ROUTES) {
      const last = r.stations.length - 1;
      for (const rt of [...routeTrains]) {
        if (rt.routeId !== r.id) continue;
        const t = raw.trains[rt.code];
        const rp = t.routes[r.id];
        if (Math.random() > 0.4) continue;
        if (Math.random() < 0.08) t.delay += 1 + Math.floor(Math.random() * 3);
        const step = rp.dir === 'down' ? 0.5 : -0.5;
        rp.pos += step;
        rp.at = now;
        if (rp.pos % 1 !== 0) {
          const from = rp.dir === 'down' ? rp.pos - 0.5 : rp.pos + 0.5;
          t.last = { name: r.stations[from].name, event: 'Departed', at: now };
          raw.sections[r.id + ':' + rp.dir + ':' + Math.floor(rp.pos)] = { delay: t.delay, at: now };
        } else {
          t.last = { name: r.stations[rp.pos].name, event: 'Arrived', at: now };
        }
        if (rp.pos <= 0 || rp.pos >= last) {
          routeTrains.splice(routeTrains.indexOf(rt), 1);
          retire(rt.code);
        }
      }
      for (const dir of ['down', 'up']) {
        const mine = routeTrains.filter((x) => x.routeId === r.id && raw.trains[x.code].routes[r.id].dir === dir);
        if (mine.length < 4 && Math.random() < 0.25) {
          const t = newTrain(dir);
          const start = dir === 'down' ? 0.5 : last - 0.5;
          t.routes[r.id] = { pos: start, dir, at: now };
          t.last = { name: r.stations[dir === 'down' ? 0 : last].name, event: 'Departed', at: now };
          routeTrains.push({ code: t.code, routeId: r.id });
        }
      }
    }
    raw.updated = now;
  }

  for (let i = 0; i < 40; i++) tick();
  return { raw, tick };
}
