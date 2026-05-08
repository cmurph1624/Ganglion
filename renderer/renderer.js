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

  api.onTabStatus(({ tabId, status }) => {
    const t = tabs.get(tabId);
    if (t) t.statusEl.dataset.status = status;
  });

  document.getElementById('new-tab-btn').addEventListener('click', () => addTab());

  window.addEventListener('resize', () => {
    for (const t of tabs.values()) {
      try { t.fitAddon.fit(); } catch {}
      try { t.fitAddonRight.fit(); } catch {}
    }
  });

  setInterval(syncCwds, 5000);
  window.addEventListener('beforeunload', () => {
    api.saveState(state);
  });
}

function addTab() {
  const id = uuid();
  const tabData = {
    id,
    name: `Tab ${state.tabs.length + 1}`,
    cwd: null,
    splitPosition: 0.5
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

function renderTab(tabData) {
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.id = tabData.id;

  const statusEl = document.createElement('span');
  statusEl.className = 'status-dot';
  statusEl.dataset.status = 'idle';

  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = tabData.name;

  const closeEl = document.createElement('button');
  closeEl.className = 'tab-close';
  closeEl.textContent = '×';
  closeEl.title = 'Close tab';

  tabEl.append(statusEl, titleEl, closeEl);

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

  const termPaneEl = document.createElement('div');
  termPaneEl.className = 'terminal-pane';
  const termHost = document.createElement('div');
  termHost.className = 'terminal-host';
  termPaneEl.appendChild(termHost);

  const divider = document.createElement('div');
  divider.className = 'divider';

  const termPaneRightEl = document.createElement('div');
  termPaneRightEl.className = 'terminal-pane';
  const termHostRight = document.createElement('div');
  termHostRight.className = 'terminal-host';
  termPaneRightEl.appendChild(termHostRight);

  pane.append(termPaneEl, divider, termPaneRightEl);
  document.getElementById('tab-panes').appendChild(pane);

  const term = new Terminal(makeTerminalConfig());
  const fitAddon = new FitAddonCtor();
  term.loadAddon(fitAddon);
  term.open(termHost);
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

  const termRight = new Terminal(makeTerminalConfig());
  const fitAddonRight = new FitAddonCtor();
  termRight.loadAddon(fitAddonRight);
  termRight.open(termHostRight);
  const rightId = tabData.id + '-right';
  requestAnimationFrame(() => {
    try { fitAddonRight.fit(); } catch {}
    api.ptySpawn(rightId, tabData.cwd);
  });

  termRight.onData((data) => api.ptyWrite(rightId, data));
  termRight.onResize(({ cols, rows }) => api.ptyResize(rightId, cols, rows));

  const disposeDataRight = api.onPtyData(rightId, (data) => termRight.write(data));
  const disposeExitRight = api.onPtyExit(rightId, () => {
    termRight.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
  });

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    divider.classList.add('dragging');
    const onMove = (ev) => {
      const rect = pane.getBoundingClientRect();
      let pct = (ev.clientX - rect.left) / rect.width;
      pct = Math.max(0.1, Math.min(0.9, pct));
      tabData.splitPosition = pct;
      pane.style.setProperty('--left-width', `${pct * 100}%`);
      try { fitAddon.fit(); } catch {}
      try { fitAddonRight.fit(); } catch {}
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

  tabs.set(tabData.id, {
    tabData, tabEl, pane, term, fitAddon,
    termRight, fitAddonRight,
    disposeData, disposeExit, disposeDataRight, disposeExitRight,
    statusEl, titleEl
  });
}

function startRenameTab(tabData, titleEl) {
  const input = document.createElement('input');
  input.className = 'tab-title-input';
  input.value = tabData.name;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim() || tabData.name;
    tabData.name = newName;
    titleEl.textContent = newName;
    input.replaceWith(titleEl);
    persistState();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') {
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
        try { t.fitAddon.fit(); } catch {}
        try { t.fitAddonRight.fit(); } catch {}
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
  try { t.disposeDataRight?.(); } catch {}
  try { t.disposeExitRight?.(); } catch {}
  try { t.term.dispose(); } catch {}
  try { t.termRight.dispose(); } catch {}
  api.ptyKill(id);
  api.ptyKill(id + '-right');
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
      }
    } catch {}
  }
  if (changed) persistState();
}

init();
