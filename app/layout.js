// What the app draws. Shared by the app and the data service.
//
// PANELS (design A): a signal box panel for one Train Describer (TD) area.
//   Each road lists its berths with the column they sit in (0 = far left).
//
// ROUTES (design C): a line of stations. Stations are matched to the
//   train movement feed (TRUST) by STANOX code. `stanox` is filled in
//   automatically from Network Rail's CORPUS file (`npm run corpus`),
//   using each station's 3-letter CRS code.
//   Stations are listed away from London, so "down" = towards the end
//   of the list and "up" = towards London.

// York (TD area Y1). Live, the server builds the real layout from Network Rail's
// SMART berth data (server/panelbuild.js) using YORK below. The demo uses the made-up
// berth numbers in DEMO_YORK so the panel has something to show before that.
export const YORK = {
  id: 'york', name: 'York', subtitle: 'York ROC · TD area Y1', area: 'Y1', stanme: 'YORK',
  ends: ['DONCASTER · LEEDS', 'DARLINGTON · SCARBOROUGH']
};

function demoRoad(name, n, dir, cols) {
  const base = 1000 + n * 10;
  return { name, dir, berths: cols.map((c) => ({ id: String(base + c).padStart(4, '0'), col: c, kind: c === 3 || c === 4 ? 'platform' : 'line' })) };
}
const ALL = [0, 1, 2, 3, 4, 5, 6, 7];
export const DEMO_YORK = {
  ...YORK, style: 'iecc',
  tracks: [
    demoRoad('1', 1, 'up', [0, 1, 2, 3]), demoRoad('2', 2, 'up', [0, 1, 2, 3]),
    demoRoad('3', 3, 'down', ALL), demoRoad('4', 4, 'up', ALL), demoRoad('5', 5, 'down', ALL),
    demoRoad('6', 6, 'up', ALL), demoRoad('7', 7, 'down', ALL), demoRoad('8', 8, 'up', ALL),
    demoRoad('9', 9, 'down', ALL), demoRoad('10', 10, 'down', ALL), demoRoad('11', 11, 'up', [4, 5, 6, 7])
  ]
};

export const PANELS = [DEMO_YORK];

export const ROUTES = [
  {
    id: 'bml',
    name: 'Brighton Main Line',
    stations: [
      { name: 'London Victoria', crs: 'VIC' },
      { name: 'Clapham Junction', crs: 'CLJ' },
      { name: 'East Croydon', crs: 'ECR' },
      { name: 'Gatwick Airport', crs: 'GTW' },
      { name: 'Haywards Heath', crs: 'HHE' },
      { name: 'Brighton', crs: 'BTN' }
    ]
  }
];
