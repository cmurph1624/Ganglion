const api = window.ganglionAPI;
const { Terminal } = window;
const FitAddonCtor = window.FitAddon.FitAddon;

let state = { tabs: [], activeTabId: null };
const tabs = new Map();
let saveTimer = null;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function persistState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveState(state), 200);
}

async function init() {
  state = (await api.loadState()) || { tabs: [], activeTabId: null };
  if (!state.tabs) state.tabs = [];

  if (state.tabs.length === 0) {
    addTab();
  } else {
    for (const t of state.tabs) renderTab(t);
    const activeId = state.activeTabId && tabs.has(state.activeTabId)
      ? state.activeTabId
      : state.tabs[0].id;
    setActive(activeId);
  }

  if ('Notification' in window) Notification.requestPermission();

  api.onTabStatus(({ tabId, status }) => {
    const t = tabs.get(tabId);
    if (!t) return;
    t.statusEl.dataset.status = status;
    if (status === 'waiting' && (document.hidden || tabId !== state.activeTabId)) {
      if (Notification.permission === 'granted') {
        new Notification('Ganglion — input needed', {
          body: `Claude is waiting in "${t.tabData.name}"`
        });
      }
    }
    if (status !== 'working') t.toolLabelEl.textContent = '';
  });

  api.onTabTool(({ tabId, tool }) => {
    const t = tabs.get(tabId);
    if (!t) return;
    if (tool && t.statusEl.dataset.status === 'working') {
      t.toolLabelEl.textContent = tool;
    } else {
      t.toolLabelEl.textContent = '';
    }
  });

  document.getElementById('new-tab-btn').addEventListener('click', () => addTab());

  window.addEventListener('resize', () => {
    for (const t of tabs.values()) fitAll(t);
  });

  setInterval(syncCwds, 5000);
  window.addEventListener('beforeunload', () => {
    api.saveState(state);
  });
}

function fitAll(t) {
  try { t.fitAddon.fit(); } catch {}
  if (t.fitAddonRight) {
    try { t.fitAddonRight.fit(); } catch {}
  }
}

function addTab() {
  const id = uuid();
  const tabData = {
    id,
    name: `Tab ${state.tabs.length + 1}`,
    cwd: null,
    splitPosition: 0.5,
    panelMode: 'hidden',
    markdownFile: null,
    autoName: true
  };
  state.tabs.push(tabData);
  renderTab(tabData);
  setActive(id);
  persistState();
}

function makeTerminalConfig() {
  return {
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
      cursorAccent: '#1e1e1e',
      selectionBackground: '#264f78'
    },
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true
  };
}

function attachImagePasteHandler(hostEl, tabId) {
  hostEl.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;

    e.preventDefault();
    e.stopPropagation();

    const blob = imageItem.getAsFile();
    if (!blob) return;

    try {
      const resp = await fetch('/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': imageItem.type },
        body: blob
      });
      if (!resp.ok) throw new Error('Upload failed');
      const result = await resp.json();
      api.ptyWrite(tabId, result.path);
    } catch (err) {
      console.error('Image paste failed:', err);
    }
  }, true);
}

function renderTab(tabData) {
  if (!tabData.panelMode) tabData.panelMode = 'hidden';
  if (!tabData.markdownFile) tabData.markdownFile = null;
  if (tabData.autoName === undefined) tabData.autoName = true;

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.id = tabData.id;

  const statusEl = document.createElement('span');
  statusEl.className = 'status-dot';
  statusEl.dataset.status = 'idle';

  const toolLabelEl = document.createElement('span');
  toolLabelEl.className = 'tool-label';

  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = tabData.name;

  const closeEl = document.createElement('button');
  closeEl.className = 'tab-close';
  closeEl.textContent = '×';
  closeEl.title = 'Close tab';

  tabEl.append(statusEl, toolLabelEl, titleEl, closeEl);

  tabEl.addEventListener('mousedown', (e) => {
    if (e.target === closeEl) return;
    setActive(tabData.id);
  });

  titleEl.addEventListener('dblclick', () => startRenameTab(tabData, titleEl));
  closeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tabData.id);
  });

  document.getElementById('tab-list').appendChild(tabEl);

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.id = tabData.id;
  pane.style.setProperty('--left-width', `${(tabData.splitPosition ?? 0.5) * 100}%`);

  const paneMain = document.createElement('div');
  paneMain.className = 'pane-main';

  const termPaneEl = document.createElement('div');
  termPaneEl.className = 'terminal-pane';
  const termHost = document.createElement('div');
  termHost.className = 'terminal-host';
  termPaneEl.appendChild(termHost);
  paneMain.appendChild(termPaneEl);

  const toggleStrip = document.createElement('div');
  toggleStrip.className = 'panel-toggle-strip';

  const termToggle = document.createElement('button');
  termToggle.className = 'panel-toggle-btn';
  termToggle.textContent = '>_';
  termToggle.title = 'Toggle terminal panel';

  const mdToggle = document.createElement('button');
  mdToggle.className = 'panel-toggle-btn';
  mdToggle.textContent = '¶';
  mdToggle.title = 'Toggle markdown panel';

  toggleStrip.append(termToggle, mdToggle);
  paneMain.appendChild(toggleStrip);

  const divider = document.createElement('div');
  divider.className = 'divider';

  const rightPanel = document.createElement('div');
  rightPanel.className = 'right-panel';

  const termPaneRightEl = document.createElement('div');
  termPaneRightEl.className = 'terminal-pane';
  termPaneRightEl.style.display = 'none';
  const termHostRight = document.createElement('div');
  termHostRight.className = 'terminal-host';
  termPaneRightEl.appendChild(termHostRight);

  const mdViewer = document.createElement('div');
  mdViewer.className = 'markdown-viewer';
  mdViewer.style.display = 'none';

  const mdToolbar = document.createElement('div');
  mdToolbar.className = 'markdown-toolbar';
  const mdInput = document.createElement('input');
  mdInput.type = 'text';
  mdInput.placeholder = 'File path…';
  mdInput.value = tabData.markdownFile || '';
  const mdOpenBtn = document.createElement('button');
  mdOpenBtn.textContent = 'Open';
  mdToolbar.append(mdInput, mdOpenBtn);

  const mdContent = document.createElement('div');
  mdContent.className = 'markdown-content';

  mdViewer.append(mdToolbar, mdContent);
  rightPanel.append(termPaneRightEl, mdViewer);
  pane.append(paneMain, divider, rightPanel);
  document.getElementById('tab-panes').appendChild(pane);

  const term = new Terminal(makeTerminalConfig());
  const fitAddon = new FitAddonCtor();
  term.loadAddon(fitAddon);
  term.open(termHost);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.metaKey) {
      if (e.key === 'v' || e.key === 'V' || (e.shiftKey && e.key === 'C')) return false;
      e.preventDefault();
      return true;
    }
    return true;
  });

  attachImagePasteHandler(termHost, tabData.id);

  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch {}
    api.ptySpawn(tabData.id, tabData.cwd);
  });

  term.onData((data) => api.ptyWrite(tabData.id, data));
  term.onResize(({ cols, rows }) => api.ptyResize(tabData.id, cols, rows));

  const disposeData = api.onPtyData(tabData.id, (data) => term.write(data));
  const disposeExit = api.onPtyExit(tabData.id, () => {
    term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
  });

  const entry = {
    tabData, tabEl, pane, paneMain, term, fitAddon,
    termRight: null, fitAddonRight: null,
    termPaneRightEl, termHostRight,
    disposeData, disposeExit,
    disposeDataRight: null, disposeExitRight: null,
    statusEl, titleEl, toolLabelEl,
    rightPanel, divider,
    termToggle, mdToggle,
    mdViewer, mdInput, mdContent
  };

  tabs.set(tabData.id, entry);

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    divider.classList.add('dragging');
    const onMove = (ev) => {
      const rect = pane.getBoundingClientRect();
      let pct = (ev.clientX - rect.left) / rect.width;
      pct = Math.max(0.1, Math.min(0.9, pct));
      tabData.splitPosition = pct;
      pane.style.setProperty('--left-width', `${pct * 100}%`);
      fitAll(entry);
    };
    const onUp = () => {
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  termToggle.addEventListener('click', () => {
    setPanelMode(tabData.id, tabData.panelMode === 'terminal' ? 'hidden' : 'terminal');
  });
  mdToggle.addEventListener('click', () => {
    setPanelMode(tabData.id, tabData.panelMode === 'markdown' ? 'hidden' : 'markdown');
  });

  mdOpenBtn.addEventListener('click', () => loadMarkdownFile(tabData.id));
  mdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadMarkdownFile(tabData.id);
  });

  applyPanelMode(tabData.id);

  if (tabData.markdownFile && tabData.panelMode === 'markdown') {
    loadMarkdownFile(tabData.id);
  }
}

function spawnRightTerminal(entry) {
  if (entry.termRight) return;
  const rightId = entry.tabData.id + '-right';
  const termRight = new Terminal(makeTerminalConfig());
  const fitAddonRight = new FitAddonCtor();
  termRight.loadAddon(fitAddonRight);
  termRight.open(entry.termHostRight);

  termRight.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.metaKey) {
      if (e.key === 'v' || e.key === 'V' || (e.shiftKey && e.key === 'C')) return false;
      e.preventDefault();
      return true;
    }
    return true;
  });

  attachImagePasteHandler(entry.termHostRight, rightId);

  requestAnimationFrame(() => {
    try { fitAddonRight.fit(); } catch {}
    api.ptySpawn(rightId, entry.tabData.cwd);
  });

  termRight.onData((data) => api.ptyWrite(rightId, data));
  termRight.onResize(({ cols, rows }) => api.ptyResize(rightId, cols, rows));

  entry.disposeDataRight = api.onPtyData(rightId, (data) => termRight.write(data));
  entry.disposeExitRight = api.onPtyExit(rightId, () => {
    termRight.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
  });

  entry.termRight = termRight;
  entry.fitAddonRight = fitAddonRight;
}

function destroyRightTerminal(entry) {
  if (!entry.termRight) return;
  const rightId = entry.tabData.id + '-right';
  try { entry.disposeDataRight?.(); } catch {}
  try { entry.disposeExitRight?.(); } catch {}
  try { entry.termRight.dispose(); } catch {}
  api.ptyKill(rightId);
  entry.termRight = null;
  entry.fitAddonRight = null;
  entry.disposeDataRight = null;
  entry.disposeExitRight = null;
}

function setPanelMode(tabId, mode) {
  const entry = tabs.get(tabId);
  if (!entry) return;
  entry.tabData.panelMode = mode;
  applyPanelMode(tabId);
  persistState();
}

function applyPanelMode(tabId) {
  const entry = tabs.get(tabId);
  if (!entry) return;
  const mode = entry.tabData.panelMode || 'hidden';

  entry.termToggle.classList.toggle('active', mode === 'terminal');
  entry.mdToggle.classList.toggle('active', mode === 'markdown');
  entry.pane.classList.toggle('has-panel', mode !== 'hidden');

  if (mode === 'terminal') {
    entry.termPaneRightEl.style.display = '';
    entry.mdViewer.style.display = 'none';
    spawnRightTerminal(entry);
  } else if (mode === 'markdown') {
    entry.termPaneRightEl.style.display = 'none';
    entry.mdViewer.style.display = '';
    destroyRightTerminal(entry);
  } else {
    entry.termPaneRightEl.style.display = 'none';
    entry.mdViewer.style.display = 'none';
    destroyRightTerminal(entry);
  }

  requestAnimationFrame(() => fitAll(entry));
}

async function loadMarkdownFile(tabId) {
  const entry = tabs.get(tabId);
  if (!entry) return;
  const filePath = entry.mdInput.value.trim();
  if (!filePath) return;

  entry.mdContent.textContent = 'Loading…';
  try {
    const resp = await fetch(`/file?path=${encodeURIComponent(filePath)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const text = await resp.text();
    entry.mdContent.innerHTML = marked.parse(text);
    entry.tabData.markdownFile = filePath;
    persistState();
  } catch (err) {
    entry.mdContent.textContent = `Error: ${err.message}`;
  }
}

function startRenameTab(tabData, titleEl) {
  const input = document.createElement('input');
  input.className = 'tab-title-input';
  input.value = tabData.name;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  let cancelled = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim() || tabData.name;
    tabData.name = newName;
    if (!cancelled) tabData.autoName = false;
    titleEl.textContent = newName;
    input.replaceWith(titleEl);
    persistState();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') {
      cancelled = true;
      input.value = tabData.name;
      input.blur();
    }
  });
}

function setActive(id) {
  state.activeTabId = id;
  for (const [tid, t] of tabs.entries()) {
    const active = tid === id;
    t.tabEl.classList.toggle('active', active);
    t.pane.classList.toggle('active', active);
    if (active) {
      requestAnimationFrame(() => {
        fitAll(t);
        t.term.focus();
      });
    }
  }
  persistState();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  try { t.disposeData?.(); } catch {}
  try { t.disposeExit?.(); } catch {}
  try { t.term.dispose(); } catch {}
  api.ptyKill(id);
  destroyRightTerminal(t);
  t.tabEl.remove();
  t.pane.remove();
  tabs.delete(id);
  state.tabs = state.tabs.filter((x) => x.id !== id);

  if (state.activeTabId === id) {
    state.activeTabId = state.tabs[0]?.id || null;
  }
  if (state.tabs.length === 0) {
    addTab();
  } else if (state.activeTabId) {
    setActive(state.activeTabId);
  }
  persistState();
}

async function syncCwds() {
  let changed = false;
  for (const t of tabs.values()) {
    try {
      const cwd = await api.ptyCwd(t.tabData.id);
      if (cwd && cwd !== t.tabData.cwd) {
        t.tabData.cwd = cwd;
        changed = true;
        if (t.tabData.autoName !== false) {
          try {
            const name = await api.getRepoName(t.tabData.id, cwd);
            if (name) {
              t.tabData.name = name;
              t.titleEl.textContent = name;
            }
          } catch {}
        }
      }
    } catch {}
  }
  if (changed) persistState();
}

init();
