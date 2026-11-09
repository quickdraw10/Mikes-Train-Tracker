# Mike's Train Tracker

Live UK train positions and delays, drawn from Network Rail's signalling data, in the Vouch colours.

- **Map (design D)** – every train in the country on a real map. Zoomed out, each train is a dot
  coloured by delay; zoom in and they become headcode chips and stations appear. Search any station,
  tap the gold arrow to jump to where you are, tap a station for its departures and arrivals, and
  "Watch this area" to keep a chip for it (e.g. Nottingham) that opens a live log of every train
  movement within 15 km.
- **Boards** – departures and arrivals for any station: search, "Find stations near me", or saved stations.
- **Panel (design A)** – York station (TD area Y1) drawn like a signaller's IECC screen: one road per
  platform with its approach berths at each end, headcodes in boxes coloured by delay, occupied track lit
  white and live signal heads. The layout is built on start-up from Network Rail's SMART berth data
  (`server/panelbuild.js`); signals are learnt from the S-Class feed as trains pass
  (`server/decode.js`) and fill in over the first hour or so. Check what SMART gave at `/api/panel-debug`.
- **Train screen** – tap any train for where it came from, where it's going, its next stop with expected
  time and platform, and every stop with booked and actual times. The service downloads Network Rail's
  daily timetable (`server/timetable.js`) and matches each live train to it.
- **Route (design C)** – a line of stations with Down and Up tracks. Each section is coloured
  by the delay of the train in it, or the last train through it in the past 20 minutes.

Delay colours everywhere: **blue** on time · **orange** 2–9 min late · **red** 10+ min late or cancelled.
Gold is only for trims.

## How it fits together

```
Network Rail feeds ──► data service (server/) ──► app (app/) on your phone
  TD   = which berth each train is in              live updates every second
  TRUST = when it passed each station, how late
```

- `server/` – a small Node.js service. It listens to the **TD** (Train Describer) and
  **TRUST** (train movements) feeds, keeps the current picture in memory and streams it
  to the app. Without a feed login it runs on invented demo trains.
- `app/` – the web app (plain HTML/CSS/JS, no build step). Add it to your iPhone home screen
  from Safari. If it can't reach a data service it shows demo trains.
- `app/layout.js` – **what gets drawn**: the panel's tracks and berths, and the route's stations.
  This is the file to edit to add panels and routes.

## Run it on a computer

Needs Node.js 20 or newer.

```
cd server
npm install
npm start          # demo trains, open http://localhost:8080
npm test           # checks the feed parsing with sample messages
```

## Going live

1. **Get a feed login.** Register at https://publicdatafeeds.networkrail.co.uk/ , confirm your
   email, log in and change your password, then wait for the email saying the account is
   active. There is no per-feed sign-up: the service subscribes to TD and Train Movements itself
   when it connects.
2. **Set the login** as environment variables (copy `.env.example`):
   `NR_USER` (your email) and `NR_PASS`.
3. **Station codes for the route view:** `npm run corpus` downloads Network Rail's CORPUS file
   once and saves `server/data/stanox.json`.
4. **Real berths for the panel:** `npm run smart -- VC` downloads Network Rail's SMART berth
   reference and saves every berth step in area VC with its station and platform
   (`server/data/smart-VC.json`). SMART is known to have gaps, so then `npm run sniff -- VC 15` listens to TD area VC for 15 minutes
   and saves `server/data/berths-VC.json` (every berth seen, which berths trains step to next,
   sample headcodes). The berth IDs in `app/layout.js` are placeholders until these are copied in.
   VC is believed to be the area covering Clapham Junction; the sniff confirms it.
5. **Signals:** `npm run signals -- VC 60` works out which signalling bit is each berth's signal by
   watching which bit drops to red as each train passes, and saves `server/data/signals-VC.json`.
   Busy signals decode within an hour; rarely used ones can take days, and running it again adds to
   what it found. If an area sends no signalling data the tool says so, and its signals stay hollow.
6. **Station boards:** register at https://raildata.org.uk (free, "Individual not affiliated with a
   company"), subscribe to **Live Departure Board** and, for arrivals, **Live Arrival
   Board**, and copy each product's Consumer key into `LDB_KEY` and `LDB_ARR_KEY`.
7. `npm start` – it now says "live mode". The map needs `npm run corpus` (step 3) to know which
   station each movement report is at.

## Hosting on Railway

1. Sign in at https://railway.com with GitHub, then **New Project → Deploy from GitHub repo →
   Mikes-Train-Tracker**. Railway reads `railway.json` and `package.json` and starts the service.
2. In the service's **Variables** tab add `NR_USER` and `NR_PASS` (your Network Rail open data
   login), and later `LDB_KEY` / `LDB_ARR_KEY` (Rail Data Marketplace). Never put these in GitHub.
3. In **Settings → Networking**, press **Generate Domain** to get the service's web address.
4. Put that address in `app/config.js` as `API_BASE` so the GitHub Pages app uses it.

On each start the service downloads the station codes (CORPUS) itself and connects to the feeds.
Feed status: https://nrodcaci.grafana.net/public-dashboards/960fa54d94884dc7abd1f5ab9c70df7e

## Hosting elsewhere

The data service has to stay connected to the feeds all the time, so it needs an always-on
Node.js host (a small cloud server or a Raspberry Pi at home). GitHub Pages can host the app
on its own, but not the service. When the app is hosted somewhere other than the service, set
`API_BASE` in `app/config.js` to the service's address.

## Known limits (first version)

- Positions jump berth to berth, as on a real panel. That is how the signalling reports them.
- Headcodes are not unique across the country. Once a train is matched to a full TRUST train ID
  at one of our stations, other trains with the same headcode are ignored, but a train only seen
  on the panel can briefly pick up the wrong delay.
- Trains are only coloured once TRUST has reported them; until then they show as on time.
- TRUST only reports what has already happened, rounded to whole minutes (so "1 min late" can be
  about 30 seconds), and not every location reports. The panel's TD positions are more frequent.
- Signals show **on** (red) or **off** only. The feed reports whether a signal is at its most
  restrictive aspect, not whether it shows green, single or double yellow. Not every signalling
  area sends this data, and some send only part of it.
- TRUST has a short planned outage most Sundays around 02:00–02:15; missed messages arrive after.

- On the map, trains are placed at the last station that reported them and then moved towards
  the next reporting point using the feed's own running-time estimate. Junctions and other
  non-station timing points have no map position, so a train can sit at its last station until the
  next station report.
- The map shows up to 600 trains at once (the most delayed first); zoom in to see every train in an area.

## Credits

- Station list: [uk-railway-stations](https://github.com/davwheat/uk-railway-stations), Open Database License (ODbL).
- Map: © OpenStreetMap contributors (tile.openstreetmap.org, fine for personal use; a commercial version would need its own tile provider).
- Train data: Network Rail open data feeds; station boards from National Rail via the Rail Data Marketplace.
  The Live Departure Board licence requires National Rail to be credited wherever its data is shown (done on
  every live board) and allows commercial use only where the data has been enhanced or combined with other data.

## Still to build

- Real berth layout for Clapham Junction (needs the sniff above)
- Design B (network wall map) and D (zoomed street map)
- Departure boards, train journey screen, saved stations, alerts
