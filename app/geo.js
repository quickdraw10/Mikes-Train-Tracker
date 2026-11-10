// Station lookups shared by the app and the data service.

import { STATIONS } from './stations.js';

export const BY_CRS = new Map(STATIONS.map(([crs, name, lat, lon]) => [crs, { crs, name, lat, lon }]));

// Stations outside Great Britain (Ireland so far), added from the data service
export function addStations(list) {
  for (const s of list || []) {
    if (!s.crs || BY_CRS.has(s.crs)) continue;
    STATIONS.push([s.crs, s.name, s.lat, s.lon]);
    BY_CRS.set(s.crs, { crs: s.crs, name: s.name, lat: s.lat, lon: s.lon, country: s.country || null, nLines: s.nLines || null, lines: s.lines || null });
  }
}

export function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

export function nearest(lat, lon, n = 5) {
  return STATIONS.map(([crs, name, sLat, sLon]) => ({ crs, name, lat: sLat, lon: sLon, km: km(lat, lon, sLat, sLon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}

// Station search by name or 3-letter code: exact code first, then names starting with the
// text, then names containing it.
export function searchStations(q, n = 8) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const scored = [];
  for (const [crs, name, lat, lon] of STATIONS) {
    const nm = name.toLowerCase();
    let score = -1;
    if (crs.toLowerCase() === s) score = 0;
    else if (nm === s) score = 1;
    else if (nm.startsWith(s)) score = 2;
    else if (nm.split(/[\s(-]+/).some((w) => w.startsWith(s))) score = 3;
    else if (nm.includes(s)) score = 4;
    if (score >= 0) scored.push({ crs, name, lat, lon, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length).slice(0, n);
}

export function inBox(lat, lon, box) {
  return lat >= box.s && lat <= box.n && lon >= box.w && lon <= box.e;
}
