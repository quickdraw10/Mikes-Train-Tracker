// Builds a single self-contained page of the app running on demo trains
// (no data service needed), for a quick look on a phone.
//   node scripts/build-preview.mjs  ->  dist/preview.html

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = (f) => fs.readFileSync(path.join(root, 'app', f), 'utf8');
const strip = (src) => src.replace(/^import .*?;\s*$/gm, '').replace(/^export (const|function|async function)/gm, '$1');

const js = [
  'const API_BASE = null;',
  strip(app('layout.js')),
  strip(app('model.js')),
  strip(app('sim.js')),
  strip(app('app.js'))
].join('\n');

const html = app('index.html');
const body = html.slice(html.indexOf('<main'), html.indexOf('<script type="module"'));

const out = `<title>Train Tracker</title>
<meta name="theme-color" content="#0B0D12">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@600;700&family=JetBrains+Mono:wght@600;700&display=swap">
<style>
${app('style.css').replace(/body\[data-theme/g, 'body[data-app-theme')}
</style>
${body}
<script type="module">
document.body.dataset.appTheme = 'dark';
${js.replace(/document\.body\.dataset\.theme/g, 'document.body.dataset.appTheme')}
</script>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'preview.html'), out);
console.log('Wrote dist/preview.html', (out.length / 1024).toFixed(1) + ' KB');
