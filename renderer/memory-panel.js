// Global "Memory" recall overlay. Cross-project/cross-session, so it lives at app
// level rather than inside a per-tab panel. Uses window.ganglionAPI + global marked.
(() => {
  const api = window.ganglionAPI;

  // --- Toolbar button ---------------------------------------------------------
  const btn = document.createElement('button');
  btn.id = 'memory-btn';
  btn.textContent = '🧠 Memory';
  btn.title = 'Search memory (Ctrl/Cmd+K)';
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.appendChild(btn);

  // --- Overlay scaffold -------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.id = 'memory-overlay';
  overlay.innerHTML = `
    <div class="mem-header">
      <span class="mem-title">Memory</span>
      <button class="mem-close" title="Close">✕</button>
    </div>
    <div class="mem-controls">
      <input class="mem-query" type="text" placeholder="Search sessions and notes…" />
      <div class="mem-filters">
        <select class="mem-source">
          <option value="all">All</option>
          <option value="session">Sessions</option>
          <option value="note">Notes</option>
        </select>
        <select class="mem-project"><option value="">All projects</option></select>
        <input class="mem-tool" type="text" placeholder="tool" size="6" />
        <input class="mem-from" type="date" title="from date" />
        <input class="mem-to" type="date" title="to date" />
        <button class="mem-go">Search</button>
      </div>
    </div>
    <div class="mem-results"></div>`;
  document.body.appendChild(overlay);

  const q = overlay.querySelector('.mem-query');
  const sourceSel = overlay.querySelector('.mem-source');
  const projectSel = overlay.querySelector('.mem-project');
  const toolInput = overlay.querySelector('.mem-tool');
  const fromInput = overlay.querySelector('.mem-from');
  const toInput = overlay.querySelector('.mem-to');
  const resultsEl = overlay.querySelector('.mem-results');

  // --- Helpers ----------------------------------------------------------------
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
  // Convert the [[ ]] highlight markers from FTS snippet() into <mark> after escaping.
  function renderSnippet(s) {
    return escapeHtml(s).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>');
  }
  function relTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diff = (Date.now() - then) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }
  function shortProject(p) {
    if (!p) return '';
    // Session project slugs look like "-home-claudedev-Documents-dev-Ganglion".
    if (p.startsWith('-')) return p.split('-').filter(Boolean).slice(-1)[0];
    return p; // note folder, already readable
  }

  // --- State ------------------------------------------------------------------
  let projectsLoaded = false;
  async function loadProjects() {
    try {
      const projs = await api.memoryProjects();
      for (const p of projs) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = shortProject(p);
        projectSel.appendChild(opt);
      }
    } catch {}
  }

  function open() {
    overlay.classList.add('open');
    btn.classList.add('active');
    if (!projectsLoaded) { loadProjects(); projectsLoaded = true; }
    q.focus();
    q.select();
  }
  function close() {
    overlay.classList.remove('open');
    btn.classList.remove('active');
  }
  function toggle() {
    overlay.classList.contains('open') ? close() : open();
  }

  async function runSearch() {
    const query = q.value.trim();
    if (!query) { resultsEl.innerHTML = '<div class="mem-empty">Type a query to search.</div>'; return; }
    resultsEl.innerHTML = '<div class="mem-empty">Searching…</div>';
    const params = {
      query,
      source: sourceSel.value,
      project: projectSel.value || undefined,
      tool: toolInput.value.trim() || undefined,
      dateFrom: fromInput.value ? `${fromInput.value}T00:00:00Z` : undefined,
      dateTo: toInput.value ? `${toInput.value}T23:59:59Z` : undefined,
      limit: 40
    };
    let results = [];
    try {
      results = await api.memorySearch(params);
    } catch {
      resultsEl.innerHTML = '<div class="mem-empty">Search failed.</div>';
      return;
    }
    renderResults(results);
  }

  function renderResults(results) {
    if (!results || results.length === 0) {
      resultsEl.innerHTML = '<div class="mem-empty">No matches.</div>';
      return;
    }
    resultsEl.innerHTML = '';
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'mem-result';
      const isNote = r.source === 'note';
      const badge = isNote ? '<span class="mem-badge note">note</span>' : `<span class="mem-badge session">${escapeHtml(r.role || 'session')}</span>`;
      const heading = isNote ? escapeHtml(r.title || '(untitled)') : shortProject(r.project);
      const meta = [
        isNote ? escapeHtml(r.project) : shortProject(r.project),
        r.ts ? relTime(r.ts) : '',
        r.tools ? `⚙ ${escapeHtml(r.tools)}` : ''
      ].filter(Boolean).join(' · ');
      row.innerHTML = `
        <div class="mem-result-head">${badge}<span class="mem-heading">${heading}</span></div>
        <div class="mem-meta">${meta}</div>
        <div class="mem-snippet">${renderSnippet(r.snippet)}</div>
        <div class="mem-expand"></div>`;
      const expand = row.querySelector('.mem-expand');
      row.querySelector('.mem-result-head').addEventListener('click', () => toggleExpand(r, expand));
      row.querySelector('.mem-snippet').addEventListener('click', () => toggleExpand(r, expand));
      resultsEl.appendChild(row);
    }
  }

  async function toggleExpand(r, expand) {
    if (expand.dataset.open === '1') {
      expand.innerHTML = '';
      expand.dataset.open = '0';
      return;
    }
    expand.dataset.open = '1';
    expand.innerHTML = '<div class="mem-loading">Loading…</div>';
    try {
      if (r.source === 'note') {
        const resp = await fetch(`/file?path=${encodeURIComponent(r.path)}`);
        const text = await resp.text();
        expand.innerHTML = `<div class="mem-note-body markdown-content">${window.marked.parse(text)}</div>
          <div class="mem-cite">${escapeHtml(r.path)}</div>`;
      } else {
        const data = await api.memoryGetTurn(r.id, 3);
        if (!data || !data.turns) { expand.innerHTML = '<div class="mem-loading">No context.</div>'; return; }
        const turns = data.turns.map((t) => {
          const who = t.role === 'assistant' ? 'assistant' : 'user';
          const body = window.marked.parse(t.text || '');
          const focus = t.uuid === r.id ? ' focus' : '';
          return `<div class="mem-turn ${who}${focus}"><span class="mem-turn-role">${who}</span><div class="markdown-content">${body}</div></div>`;
        }).join('');
        expand.innerHTML = `${turns}<div class="mem-cite">session ${escapeHtml(r.sessionId)} · ${escapeHtml(r.path)}</div>`;
      }
    } catch {
      expand.innerHTML = '<div class="mem-loading">Failed to load.</div>';
    }
  }

  // --- Wiring -----------------------------------------------------------------
  btn.addEventListener('click', toggle);
  overlay.querySelector('.mem-close').addEventListener('click', close);
  overlay.querySelector('.mem-go').addEventListener('click', runSearch);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  [sourceSel, projectSel].forEach((el) => el.addEventListener('change', () => { if (q.value.trim()) runSearch(); }));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
})();
