// S-Class TD messages: the state of signals, routes and track circuits,
// held as up to 2,048 bits per TD area (Open Rail Data wiki, S Class Messages).
//   SF_MSG  one element changed     { area_id, address, data, time }  data = 1 byte
//   SG_MSG  part of a full refresh  { area_id, address, data, time }  data = 4 bytes from address
//   SH_MSG  last part of a refresh  { area_id, address, data, time }
// Addresses and data are hex. Which bit is which signal is NOT in the feed;
// it comes from data/signals-<AREA>.json, worked out by `npm run signals`.
// A signal bit of 0 means the signal is at its most restrictive aspect (on / red);
// 1 means it is showing something else (off). The feed does not say which proceed aspect.

export function hexBytes(data) {
  const s = String(data || '').trim();
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out.filter((b) => !Number.isNaN(b));
}

export function addr(n) {
  return n.toString(16).padStart(2, '0');
}

// Applies a batch to raw.sbits[area][address] = byte. Returns the bit changes
// [{ area, key: 'addr:bit', from, to }] for SF messages (used by the decoder).
export function handleSClass(batch, raw, areas) {
  raw.sbits ||= {};
  raw.srefresh ||= {};
  const changes = [];
  for (const item of batch) {
    const [type, m] = Object.entries(item)[0] || [];
    if (!m || !areas.has(m.area_id) || !/^S[FGH]_MSG$/.test(type)) continue;
    const a = m.area_id;
    const start = parseInt(m.address, 16);
    const bytes = hexBytes(m.data);
    if (Number.isNaN(start) || !bytes.length) continue;
    const area = (raw.sbits[a] ||= {});
    if (type === 'SF_MSG') {
      const k = addr(start);
      const before = area[k];
      area[k] = bytes[0];
      if (before !== undefined && before !== bytes[0]) {
        for (let bit = 0; bit < 8; bit++) {
          const f = (before >> bit) & 1, t = (bytes[0] >> bit) & 1;
          if (f !== t) changes.push({ area: a, key: k + ':' + bit, from: f, to: t });
        }
      }
    } else {
      // Refresh: collect the series and apply it whole when SH arrives
      const buf = (raw.srefresh[a] ||= {});
      bytes.forEach((b, i) => { buf[addr(start + i)] = b; });
      if (type === 'SH_MSG') { Object.assign(area, buf); delete raw.srefresh[a]; }
    }
  }
  return changes;
}
