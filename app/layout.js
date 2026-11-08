// What the app draws. Shared by the app and the data service.
//
// PANELS (design A): a signal box panel for one Train Describer (TD) area.
//   Each track lists its berths in drawing order (left to right).
//   Berth IDs below are PLACEHOLDERS until we run the berth sniffer
//   (`npm run sniff -- VC`) against the live feed and copy in the real ones.
//
// ROUTES (design C): a line of stations. Stations are matched to the
//   train movement feed (TRUST) by STANOX code. `stanox` is filled in
//   automatically from Network Rail's CORPUS file (`npm run corpus`),
//   using each station's 3-letter CRS code.
//   Stations are listed away from London, so "down" = towards the end
//   of the list and "up" = towards London.

export const PANELS = [
  {
    id: 'clapham',
    name: 'Clapham Junction',
    subtitle: 'Brighton Main Line',
    area: 'VC',
    ends: ['VICTORIA', 'BALHAM'],
    tracks: [
      { name: 'DF', dir: 'down', berths: ['0101', '0103', '0105', '0107', '0109'] },
      { name: 'UF', dir: 'up', berths: ['0102', '0104', '0106', '0108', '0110'] },
      { name: 'DS', dir: 'down', berths: ['0201', '0203', '0205', '0207', '0209'] },
      { name: 'US', dir: 'up', berths: ['0202', '0204', '0206', '0208', '0210'] }
    ],
    // Platform blocks drawn between pairs of tracks: from/to are berth positions (0-based)
    platforms: [
      { between: [0, 1], from: 2, to: 3.6, label: 'PLAT 13–14' },
      { between: [2, 3], from: 2, to: 3.6, label: 'PLAT 15–16' }
    ]
  }
];

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
