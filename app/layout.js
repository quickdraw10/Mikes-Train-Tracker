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
  id: 'york', name: 'York', subtitle: 'York ROC · TD area Y1', crs: 'YRK', area: 'Y1', stanme: 'YORK',
  ends: ['DONCASTER · LEEDS', 'DARLINGTON · SCARBOROUGH']
};
// Live, these two find their TD area(s) from SMART by the station's STANOX code.
// Left is always the London side.
export const CLAPHAM = {
  id: 'clj', name: 'Clapham Junction', subtitle: 'South London', crs: 'CLJ',
  ends: ['VICTORIA · WATERLOO', 'BALHAM · WIMBLEDON']
};
export const CREWE = {
  id: 'cre', name: 'Crewe', subtitle: 'Cheshire', crs: 'CRE',
  ends: ['STAFFORD · STOKE', 'WARRINGTON · CHESTER']
};
// Hull Paragon is a terminus: every train comes in from the west (Brough / Selby line and the
// Beverley line, which join outside the station), so the London side is the only way out.
export const HULL = {
  id: 'hul', name: 'Hull Paragon', subtitle: 'East Yorkshire', crs: 'HUL', stanme: 'HULL',
  ends: ['BROUGH · BEVERLEY', 'BUFFER STOPS']
};
// Doncaster: the London end is the south (Retford, Sheffield, Lincoln); north to York, Leeds and Hull
export const DONCASTER = {
  id: 'don', name: 'Doncaster', subtitle: 'South Yorkshire', crs: 'DON',
  ends: ['RETFORD · SHEFFIELD · LINCOLN', 'YORK · LEEDS · HULL']
};
// Leeds: London trains come in at the west end (via Wakefield), with Bradford and Huddersfield;
// the east end goes to York, Selby and Hull
export const LEEDS = {
  id: 'lds', name: 'Leeds', subtitle: 'West Yorkshire', crs: 'LDS',
  ends: ['WAKEFIELD · BRADFORD · HUDDERSFIELD', 'YORK · SELBY · HULL']
};
export const STATION_PANELS = [YORK, LEEDS, DONCASTER, HULL, CLAPHAM, CREWE];

function demoRoad(name, n, dir, cols) {
  const base = 1000 + n * 10;
  return { name, dir, berths: cols.map((c) => ({ id: String(base + c).padStart(4, '0'), col: c, kind: c === 3 || c === 4 ? 'platform' : 'line' })) };
}
const ALL = [0, 1, 2, 3, 4, 5, 6, 7];
const LEFT = [0, 1, 2, 3], RIGHT = [4, 5, 6, 7];
export const DEMO_YORK = {
  ...YORK, style: 'iecc',
  tracks: [
    demoRoad('1', 1, 'up', LEFT), demoRoad('2', 2, 'up', LEFT),
    demoRoad('3', 3, 'down', ALL), demoRoad('4', 4, 'up', ALL), demoRoad('5', 5, 'down', ALL),
    demoRoad('6', 6, 'up', ALL), demoRoad('7', 7, 'down', ALL), demoRoad('8', 8, 'up', ALL),
    demoRoad('9', 9, 'down', ALL), demoRoad('10', 10, 'down', ALL), demoRoad('11', 11, 'up', RIGHT)
  ],
  desc: {
    down: ['London King\'s Cross → Edinburgh', 'Leeds → Scarborough', 'Manchester Airport → Newcastle', 'Plymouth → Edinburgh', 'Hull → Scarborough'],
    up: ['Edinburgh → London King\'s Cross', 'Scarborough → Leeds', 'Newcastle → Manchester Airport', 'Aberdeen → Plymouth', 'Harrogate → Leeds']
  },
  prefix: ['1S', '1E', '1N', '2C', '1P', '2H', '1V', '2R']
};
// Clapham Junction: 17 platforms, Windsor lines (1-6) and Brighton/main lines
export const DEMO_CLAPHAM = {
  ...CLAPHAM, area: 'D2', subtitle: 'Demo layout', style: 'iecc',
  tracks: Array.from({ length: 17 }, (_, i) => demoRoad(String(i + 1), i + 1, i % 2 ? 'up' : 'down', ALL)),
  desc: {
    down: ['London Waterloo → Reading', 'London Victoria → Brighton', 'London Waterloo → Woking', 'London Victoria → Gatwick Airport', 'Willesden Junction → Clapham Junction'],
    up: ['Reading → London Waterloo', 'Brighton → London Victoria', 'Guildford → London Waterloo', 'Sutton → London Victoria', 'Southampton Central → London Waterloo']
  },
  prefix: ['2C', '1D', '2J', '1R', '2H', '1L', '2U', '5C']
};
// Crewe: 12 platforms, through roads plus bays at each end
export const DEMO_CREWE = {
  ...CREWE, area: 'D3', subtitle: 'Demo layout', style: 'iecc',
  tracks: [
    demoRoad('1', 1, 'up', LEFT), demoRoad('2', 2, 'up', LEFT),
    demoRoad('3', 3, 'down', ALL), demoRoad('4', 4, 'up', ALL), demoRoad('5', 5, 'down', ALL), demoRoad('6', 6, 'up', ALL),
    demoRoad('7', 7, 'down', RIGHT), demoRoad('8', 8, 'up', RIGHT),
    demoRoad('11', 11, 'down', ALL), demoRoad('12', 12, 'up', ALL), demoRoad('13', 13, 'down', ALL), demoRoad('14', 14, 'up', ALL)
  ],
  desc: {
    down: ['London Euston → Glasgow Central', 'Birmingham New Street → Manchester Piccadilly', 'Crewe → Chester', 'London Euston → Holyhead', 'Cardiff Central → Manchester Piccadilly'],
    up: ['Glasgow Central → London Euston', 'Manchester Piccadilly → Birmingham New Street', 'Chester → Crewe', 'Holyhead → London Euston', 'Manchester Piccadilly → Cardiff Central']
  },
  prefix: ['1S', '1A', '1H', '1G', '2K', '1V', '4M', '6K']
};

export const PANELS = [DEMO_YORK, DEMO_CLAPHAM, DEMO_CREWE];

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
