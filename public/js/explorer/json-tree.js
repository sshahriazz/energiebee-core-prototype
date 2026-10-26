// Raw payload viewer. A raw body is untrusted text from a provider: it is only ever put on the page
// with textContent / text nodes, never innerHTML. JSON is shown as a collapsible tree (<details>, so
// it works from the keyboard), built lazily level by level, with search that opens the path to each
// match. Anything else is shown as plain text, with search marks.
const CHUNK = 200;
const MAX_HITS = 500;
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const SEP = '\u0001';

/** Mount the viewer into container (emptied first). Returns nothing; all state lives in the closure. */
export function jsonViewer(container, { body = '', jsonOk = false }) {
  container.textContent = '';
  let data; let isJson = false;
  if (jsonOk) { try { data = JSON.parse(body); isJson = true; } catch { isJson = false; } }

  const bar = el('div', 'xp-jbar');
  const label = el('label', 'xp-jsearch');
  label.append(el('span', 'sr-only', 'Search in this file'));
  const input = el('input');
  input.type = 'search'; input.placeholder = isJson ? 'Search keys and values' : 'Search the text'; input.autocomplete = 'off';
  label.append(input);
  const prev = el('button', 'btn', '↑'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous match');
  const next = el('button', 'btn', '↓'); next.type = 'button'; next.setAttribute('aria-label', 'Next match');
  const status = el('span', 'xp-jstatus'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  bar.append(label, prev, next, status);
  let expandBtn; let collapseBtn;
  if (isJson) {
    expandBtn = el('button', 'btn', 'Open all'); expandBtn.type = 'button';
    collapseBtn = el('button', 'btn', 'Close all'); collapseBtn.type = 'button';
    bar.append(expandBtn, collapseBtn);
  }
  const view = el('div', isJson ? 'xp-json' : 'xp-rawtext');
  view.tabIndex = 0;
  view.setAttribute('aria-label', isJson ? 'Payload as a tree' : 'Payload as text');
  container.append(bar, view);

  let hits = []; let cur = -1;
  const focusHit = (i) => {
    if (!hits.length) return;
    cur = (i + hits.length) % hits.length;
    hits.forEach((h, k) => h.classList.toggle('current', k === cur));
    hits[cur].scrollIntoView({ block: 'nearest' });
    status.textContent = `${cur + 1} of ${hits.length}${hits.length >= MAX_HITS ? '+' : ''} matches`;
  };
  prev.addEventListener('click', () => focusHit(cur - 1));
  next.addEventListener('click', () => focusHit(cur + 1));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusHit(e.shiftKey ? cur - 1 : cur + 1); } });

  if (!isJson) {
    const pre = el('pre', 'xp-pre');
    const paint = (q) => {
      pre.textContent = '';
      hits = []; cur = -1;
      if (!q) { pre.textContent = body; status.textContent = ''; return; }
      const low = body.toLowerCase(); const ql = q.toLowerCase();
      let at = 0; let i = low.indexOf(ql);
      while (i >= 0 && hits.length < MAX_HITS) {
        pre.append(document.createTextNode(body.slice(at, i)));
        const mk = el('mark', 'xp-hit', body.slice(i, i + q.length));
        pre.append(mk); hits.push(mk);
        at = i + q.length; i = low.indexOf(ql, at);
      }
      pre.append(document.createTextNode(body.slice(at)));
      status.textContent = hits.length ? '' : 'No matches';
      if (hits.length) focusHit(0);
    };
    view.append(pre);
    paint('');
    let t; input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => paint(input.value), 160); });
    return;
  }

  // ── JSON tree ──
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const isBranch = (v) => v !== null && typeof v === 'object' && Object.keys(v).length > 0;
  let q = ''; let open = new Set(); let openAll = false;
  const matches = (k, v) => q && (String(k).toLowerCase().includes(q) || (!isBranch(v) && String(v).toLowerCase().includes(q)));

  function leaf(k, v, isIndex) {
    const row = el('div', 'xp-jl');
    if (k != null) { row.append(el('span', isIndex ? 'xp-jk idx' : 'xp-jk', String(k)), el('span', 'xp-jp', ': ')); }
    const t = kind(v);
    const shown = t === 'string' ? JSON.stringify(v) : t === 'object' || t === 'array' ? (Array.isArray(v) ? '[]' : '{}') : String(v);
    row.append(el('span', `xp-jv ${t}`, shown));
    if (matches(k, v)) { row.classList.add('xp-hit'); hits.push(row); }
    return row;
  }
  function branch(k, v, path, depth, isIndex) {
    const d = el('details', 'xp-jn');
    const s = el('summary');
    if (k != null) s.append(el('span', isIndex ? 'xp-jk idx' : 'xp-jk', String(k)), el('span', 'xp-jp', ': '));
    const n = Object.keys(v).length;
    s.append(el('span', 'xp-jt', Array.isArray(v) ? `[ ${n} item${n === 1 ? '' : 's'} ]` : `{ ${n} key${n === 1 ? '' : 's'} }`));
    d.append(s);
    if (k != null && matches(k, v)) { s.classList.add('xp-hit'); hits.push(s); }
    let built = false;
    const build = () => {
      if (built) return; built = true;
      const box = el('div', 'xp-jc');
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
      const searching = q && open.has(path);
      let shown = 0;
      const more = () => {
        const end = searching || openAll ? entries.length : Math.min(entries.length, shown + CHUNK);
        for (; shown < end; shown++) {
          const [ck, cv] = entries[shown];
          const cp = `${path}${SEP}${ck}`;
          box.append(isBranch(cv) ? branch(ck, cv, cp, depth + 1, Array.isArray(v)) : leaf(ck, cv, Array.isArray(v)));
        }
        box.querySelector(':scope > .xp-jmore')?.remove();
        if (shown < entries.length) {
          const b = el('button', 'btn xp-jmore', `Show ${Math.min(CHUNK, entries.length - shown)} more of ${entries.length - shown} left`);
          b.type = 'button';
          b.addEventListener('click', () => { more(); });
          box.append(b);
        }
      };
      more();
      d.append(box);
    };
    if (openAll || depth < 1 || open.has(path)) { d.open = true; build(); }
    d.addEventListener('toggle', () => { if (d.open) build(); });
    return d;
  }
  function paint() {
    view.textContent = '';
    hits = []; cur = -1;
    view.append(isBranch(data) ? branch(null, data, '', 0, false) : leaf(null, data, false));
    if (q) { status.textContent = hits.length ? '' : 'No matches'; if (hits.length) focusHit(0); } else status.textContent = '';
  }
  // Which branches lead to a match: walk the data (not the DOM), up to MAX_HITS matches.
  function findOpen() {
    const set = new Set(); let n = 0;
    const walk = (v, path) => {
      if (n >= MAX_HITS || !isBranch(v)) return false;
      let any = false;
      for (const [k, cv] of Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v)) {
        if (n >= MAX_HITS) break;
        const cp = `${path}${SEP}${k}`;
        const hit = matches(k, cv);
        if (hit) n++;
        const below = walk(cv, cp);
        if (hit || below) any = true;
      }
      if (any) set.add(path);
      return any;
    };
    walk(data, '');
    return set;
  }
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { q = input.value.trim().toLowerCase(); openAll = false; open = q ? findOpen() : new Set(); paint(); }, 180);
  });
  expandBtn.addEventListener('click', () => { openAll = true; paint(); });
  collapseBtn.addEventListener('click', () => { openAll = false; open = new Set(); q = ''; input.value = ''; paint(); });
  paint();
}
