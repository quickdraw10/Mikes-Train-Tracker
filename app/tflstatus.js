// London line status, laid out like TfL's own status page: each line in its colour, the
// lines with problems first, and a + to read TfL's explanation. All from TfL's live status feed.
import * as api from './api.js';
import { esc, openSheet, updateSheet, sheetOpen, textOn } from './ui.js';

const band = (sev) => (sev === 10 ? 'ok' : sev === 9 || sev === 19 ? 'mid' : 'bad');
let timer = null;

export async function statusSheet(openId = null) {
  let data = null;
  const open = new Set(openId ? [openId] : []);
  const html = () => {
    const lines = data && data.lines ? data.lines : null;
    const rows = !lines ? '<div class="empty">Loading line status…</div>' : !lines.length ? '<div class="empty">TfL line status isn\'t available right now.</div>' : lines.map((l) => {
      const sts = l.statuses && l.statuses.length ? l.statuses : [{ severity: l.severity, status: l.status, reason: l.reason }];
      const why = sts.filter((s) => s.reason);
      const isOpen = open.has(l.id);
      return `<div class="ls-row${l.severity === 10 ? '' : ' bad'}">
        <div class="ls-name" style="background:${esc(l.color || '#59606B')};color:${textOn(l.color || '#59606B')}">${esc(l.name)}</div>
        <button class="ls-status" data-act="toggle" data-arg="${esc(l.id)}" ${why.length ? `aria-expanded="${isOpen}"` : 'disabled'}>
          <span class="ls-list">${sts.map((s) => `<span class="c-${band(s.severity)}">${esc(s.status || '–')}</span>`).join('')}</span>
          ${why.length ? `<span class="ls-plus" aria-hidden="true">${isOpen ? '−' : '+'}</span>` : ''}
        </button>
        ${isOpen ? `<div class="ls-why">${why.map((s) => `<p>${esc(s.reason).replace(/\n/g, '<br>')}</p>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    const bad = lines ? lines.filter((l) => l.severity !== 10).length : 0;
    return `<div class="st-head"><div><div class="meta">Live · TfL</div><h2 id="sheet-title">Line status</h2></div></div>
      ${lines && lines.length ? `<p class="ls-sum">${bad ? `<b>${bad}</b> line${bad === 1 ? '' : 's'} with problems` : 'Good service on all lines'}</p>` : ''}
      <div class="sheet-body ls">${rows}<p class="credit">Powered by TfL Open Data</p></div>`;
  };
  async function load() {
    data = (await api.tflStatus()) || { lines: [] };
    if (sheetOpen()) updateSheet(html());
  }
  openSheet(html(), {
    toggle: (id) => { if (open.has(id)) open.delete(id); else open.add(id); updateSheet(html()); }
  }, () => clearInterval(timer), 'lu');
  clearInterval(timer);
  load();
  timer = setInterval(load, 60000);
}
