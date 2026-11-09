// Train operators and their official two-letter codes (ATOC / Darwin).
// The app shows the code as a small badge in its own style: no operator logos,
// which are the operators' trademarks.

export const OPERATORS = {
  AW: 'Transport for Wales', CC: 'c2c', CH: 'Chiltern Railways', CS: 'Caledonian Sleeper', EM: 'East Midlands Railway',
  ES: 'Eurostar', GC: 'Grand Central', GN: 'Great Northern', GR: 'LNER', GW: 'GWR', GX: 'Gatwick Express', HT: 'Hull Trains',
  HX: 'Heathrow Express', IL: 'Island Line', LD: 'Lumo', LE: 'Greater Anglia', LM: 'West Midlands Trains', LO: 'London Overground',
  ME: 'Merseyrail', NT: 'Northern', NY: 'North Yorkshire Moors Railway', SE: 'Southeastern', SN: 'Southern', SR: 'ScotRail',
  SW: 'South Western Railway', TL: 'Thameslink', TP: 'TransPennine Express', TW: 'Tyne and Wear Metro', VT: 'Avanti West Coast',
  WR: 'West Coast Railways', XC: 'CrossCountry', XR: 'Elizabeth line', ZZ: null
};

// Other names the same operators go by in National Rail's data
const ALIASES = {
  'london north eastern railway': 'GR', 'great western railway': 'GW', 'west midlands railway': 'LM', 'london northwestern railway': 'LM',
  'transport for wales rail': 'AW', 'tfw rail': 'AW', 'avanti': 'VT', 'elizabeth line': 'XR', 'tfl rail': 'XR', 'c2c': 'CC',
  'gtr': 'TL', 'govia thameslink railway': 'TL', 'east midlands trains': 'EM', 'cross country': 'XC', 'transpennine express': 'TP',
  'first transpennine express': 'TP', 'merseyrail': 'ME', 'scotrail': 'SR', 'southeastern': 'SE', 'south western railway': 'SW'
};
const BY_NAME = new Map(Object.entries(OPERATORS).filter(([, n]) => n).map(([c, n]) => [n.toLowerCase(), c]));
for (const [n, c] of Object.entries(ALIASES)) BY_NAME.set(n, c);

// The code for an operator given its code or name; null when we don't know it (never guessed)
export function opCode(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^[A-Z]{2}$/.test(s) && s in OPERATORS) return s;
  return BY_NAME.get(s.toLowerCase()) || null;
}
