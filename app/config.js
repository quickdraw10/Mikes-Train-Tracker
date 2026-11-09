// Where the data service lives.
//   ''   = the same server that is showing this app (the normal setup)
//   'https://your-service.example.com' = a service hosted somewhere else
//   null = never try; always show demo trains
// The GitHub Pages app talks to the data service on Railway; when the app is opened from
// the Railway address itself it uses that same server.
export const API_BASE = location.hostname.endsWith('github.io')
  ? 'https://mikes-train-tracker-production.up.railway.app'
  : '';
