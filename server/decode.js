// Works out which S-Class bit is which signal, the way the Open Rail Data
// wiki describes ("Decoding S-Class Data"): when a train steps out of a berth
// it passes that berth's signal, which drops to red, so one bit goes 1 -> 0
// at about the same moment. Every step adds a vote for the bits that dropped;
// a bit that was already 0 when the train passed counts against it.
// Only 1 -> 0 changes are used; 0 -> 1 has too many other causes.

export const WINDOW_BEFORE = 3000; // a bit may drop a little before the step arrives
export const WINDOW_AFTER = 8000;  // ...or a little after

export function createDecoder() {
  const drops = [];     // { at, area, key }
  const steps = [];     // { at, area, from }
  const votes = {};     // area:berth -> { steps, bits: { key: { hits, against } } }

  function noteChanges(changes, at) {
    for (const c of changes) if (c.from === 1 && c.to === 0) drops.push({ at, area: c.area, key: c.key });
  }
  function noteStep(area, from, at) {
    steps.push({ at, area, from });
  }

  // Score steps old enough that every drop near them has arrived
  function settle(now, sbits) {
    while (steps.length && now - steps[0].at > WINDOW_AFTER) {
      const s = steps.shift();
      const near = drops.filter((d) => d.area === s.area && d.at >= s.at - WINDOW_BEFORE && d.at <= s.at + WINDOW_AFTER);
      const v = (votes[s.area + ':' + s.from] ||= { steps: 0, bits: {} });
      v.steps++;
      for (const d of near) (v.bits[d.key] ||= { hits: 0, against: 0 }).hits++;
      // A candidate that is still 0 and did not drop this time was already red: evidence against
      const bytes = (sbits && sbits[s.area]) || {};
      for (const [key, b] of Object.entries(v.bits)) {
        if (near.some((d) => d.key === key)) continue;
        const [address, bit] = key.split(':');
        if (bytes[address] !== undefined && ((bytes[address] >> Number(bit)) & 1) === 0) b.against++;
      }
    }
    while (drops.length && now - drops[0].at > WINDOW_BEFORE + WINDOW_AFTER * 2) drops.shift();
  }

  // Best bit for each berth, kept only when the evidence is strong
  function results({ minHits = 3, minShare = 0.8 } = {}) {
    const signals = {}, report = [];
    for (const [k, v] of Object.entries(votes)) {
      const [area, berth] = k.split(':');
      const ranked = Object.entries(v.bits)
        .map(([key, b]) => ({ key, hits: b.hits, against: b.against, share: b.hits / v.steps }))
        .sort((a, b) => b.hits - b.against - (a.hits - a.against));
      const best = ranked[0];
      const sure = best && best.hits >= minHits && best.share >= minShare && best.against === 0 && (!ranked[1] || ranked[1].hits < best.hits);
      report.push({ area, berth, steps: v.steps, best: best || null, runnerUp: ranked[1] || null, accepted: Boolean(sure) });
      if (sure) {
        const [address, bit] = best.key.split(':');
        (signals[area] ||= {})[berth] = { address, bit: Number(bit), hits: best.hits, steps: v.steps };
      }
    }
    return { signals, report: report.sort((a, b) => a.berth.localeCompare(b.berth)) };
  }

  return { noteChanges, noteStep, settle, results };
}
