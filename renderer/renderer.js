const api = window.ganglionAPI;
const { Terminal } = window;
const FitAddonCtor = window.FitAddon.FitAddon;
const { splitTabState, mergeTabState, DEFAULT_VIEW } = window.ganglionTabState;

// `state.tabs` holds MERGED tabs: the server's shared fields plus this window's view keys.
// Every mutation below edits those objects in place, because `tabs.get(id).tabData` aliases
// them and the DOM closures captured the alias -- so replacing a tab object would silently
// detach the tab bar from the state it is drawing.
let state = { tabs: [], activeTabId: null };
const tabs = new Map();
let viewSaveTimer = null;

// Per-client. Two front-ends SHOULD disagree about divider positions and which tab is
// active, so none of this goes over the wire -- see lib/tab-state.js.
const VIEW_STATE_KEY = 'ganglion.viewState';

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function loadViewState() {
  try {
    return JSON.parse(localStorage.getItem(VIEW_STATE_KEY)) || {};
  } catch {
    return {};
  }
}

function writeViewState() {
  // splitTabState() already knows which keys are per-client; asking it here keeps the two
  // halves defined in exactly one place.
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(splitTabState(state).view));
  } catch {}
}

function persistView() {
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(writeViewState, 200);
}

async function init() {
  // The server sends shared state only; this window's view of it comes from localStorage.
  state = mergeTabState(await api.loadState(), loadViewState());

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

  // A tab created, renamed, or closed anywhere -- including in this window, which sees its
  // own change come back off the broadcast. Applying both through one path is what makes
  // the two front-ends converge; the guards below are what make the echo harmless.
  api.onTabMutation((msg) => {
    switch (msg.type) {
      case 'tab:created': {
        if (!msg.tab || tabs.has(msg.tab.id)) break;
        // Arrived from the other window, so this client has no stored view for it.
        const tabData = { ...msg.tab, ...DEFAULT_VIEW };
        state.tabs.push(tabData);
        renderTab(tabData);
        // renderTab() draws the pane but does not select it. With nothing else active --
        // which is exactly the state this window is left in when the other one closes the
        // last tab -- the new pane would render without the `active` class and show blank.
        // Otherwise leave focus alone: a tab opening elsewhere must not yank this window
        // off whatever it is doing.
        if (!state.activeTabId) setActive(tabData.id);
        break;
      }
      case 'tab:updated': {
        const entry = tabs.get(msg.tabId);
        if (!entry || !msg.tab) break;
        // msg.tab carries shared fields only, so assigning over the merged object leaves
        // this window's divider position and panel mode untouched.
        const previousFile = entry.tabData.markdownFile;
        Object.assign(entry.tabData, msg.tab);
        entry.titleEl.textContent = entry.tabData.name;

        // The markdown pane is shared state pointing at a file, so a file opened in the
        // other window has to be reflected here -- but only redrawn if this window happens
        // to have the pane open.
        if (entry.tabData.markdownFile && entry.tabData.markdownFile !== previousFile) {
          entry.mdInput.value = entry.tabData.markdownFile;
          if (entry.tabData.panelMode === 'markdown') loadMarkdownFile(msg.tabId);
        }
        break;
      }
      case 'tab:closed': {
        // Closed elsewhere: tear down the local view, but leave the pty alone -- the window
        // that initiated it already sent pty:kill, and this window replacing an empty tab
        // strip would race the tab:created the other one is about to broadcast.
        if (tabs.has(msg.tabId)) teardownTab(msg.tabId, { replaceIfEmpty: false });
        break;
      }
    }
    persistView();
  });

  document.getElementById('new-tab-btn').addEventListener('click', () => addTab());

  window.addEventListener('resize', () => {
    for (const t of tabs.values()) fitAll(t);
  });

  setInterval(syncCwds, 5000);
  window.addEventListener('beforeunload', () => {
    // localStorage only, and synchronous -- a WebSocket send here is not guaranteed to
    // flush before the page goes away.
    writeViewState();
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
  const shared = {
    id,
    name: `Tab ${state.tabs.length + 1}`,
    cwd: null,
    markdownFile: null,
    autoName: true
  };
  const tabData = { ...shared, ...DEFAULT_VIEW };
  state.tabs.push(tabData);
  renderTab(tabData);
  setActive(id);
  // Only the shared half goes to the server; the view half is already in tabData and will
  // reach localStorage via setActive() -> persistView().
  api.tabCreated(shared);
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
    // Menlo/Monaco are macOS-only, so on Windows this stack fell through to Courier New --
    // a proportionally-designed print face that renders box-drawing and powerline glyphs
    // badly in a terminal. Cascadia Mono (ships with Windows Terminal) and Consolas (every
    // Windows) sit ahead of it; the macOS entries stay first so the Mac browser is unchanged.
    fontFamily: 'Menlo, Monaco, "Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true
  };
}

// Both terminals in a tab (left, and the optional right split) get the same bindings. The
// key decision lives in terminal-keys.js so the memory overlay reads the same rule, and the
// wiring lives in terminal-copy.js so it can be driven without booting the app -- see the
// headers there.
//
// Order matters only in that the mouse refusal must be registered before the pty is spawned
// below, or the first Claude Code prompt turns tracking on before anyone is listening.
//
// The two selection bindings are a pair. Refusing the mouse is what makes a plain drag
// select anything at all in a tab running Claude; copy-on-selection is what makes that
// selection worth having without reaching for a key that also means SIGINT.
function attachTerminalBindings(term) {
  window.ganglionTerminalCopy.refuseMouseReporting(term);
  window.ganglionTerminalCopy.attachKeyPolicy(term);
  window.ganglionTerminalCopy.attachCopyOnSelection(term);
}

/**
 * Optional xterm addons. Must be called AFTER term.open() -- WebGL needs a real element.
 *
 * Every one is wrapped: a browser without WebGL, or an addon that failed to load, has to
 * degrade to xterm's defaults rather than leave the tab blank. Neither is load-bearing.
 */
function loadTerminalAddons(term) {
  // Unicode 11 widths. The default tables measure several box-drawing characters and most
  // emoji one column too narrow, which shears the frame of Claude Code's TUI.
  try {
    term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch {}

  // WebGL rendering, which is the difference that shows up over RDP. Losing the GL context
  // is routine there (session reconnect, GPU driver reset), so dispose on loss and let
  // xterm fall back to canvas rather than rendering nothing at all.
  try {
    const webgl = new window.WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
    term.loadAddon(webgl);
  } catch {}
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

  // The desktop shell can offer a real file picker; a browser tab cannot, which is why the
  // path above is a text input. Feature-detected rather than branched at build time, so
  // this file stays identical for both front-ends -- in a browser `ganglionDesktop` is
  // undefined, no button is created, and the toolbar is exactly what it was.
  if (window.ganglionDesktop?.openMarkdown) {
    const mdBrowseBtn = document.createElement('button');
    mdBrowseBtn.textContent = 'Browse…';
    mdBrowseBtn.addEventListener('click', async () => {
      const picked = await window.ganglionDesktop.openMarkdown(
        mdInput.value.trim() || tabData.cwd || undefined
      );
      if (!picked) return;
      mdInput.value = picked;
      loadMarkdownFile(tabData.id);
    });
    mdToolbar.append(mdBrowseBtn);
  }

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

  loadTerminalAddons(term);
  attachTerminalBindings(term);

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
      // Purely this window's business -- the other front-end keeps its own divider.
      persistView();
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

  loadTerminalAddons(termRight);
  attachTerminalBindings(termRight);

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
  persistView();
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
    // Which file this tab is showing is part of what the tab IS, so both windows get it.
    // Whether the pane is visible (panelMode) stays local.
    api.tabUpdated(tabId, { markdownFile: filePath });
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
    // autoName goes with the name: without it the other window's syncCwds() would rename
    // the tab back to the repo name on its next 5s poll.
    api.tabUpdated(tabData.id, { name: newName, autoName: tabData.autoName });
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
  persistView();
}

/**
 * Close a tab from THIS window: kill the pty, tell the server, drop the local view.
 */
function closeTab(id) {
  if (!tabs.has(id)) return;
  api.ptyKill(id);
  api.tabClosed(id);
  teardownTab(id, { replaceIfEmpty: true });
  persistView();
}

/**
 * Drop a tab's DOM, terminal and local state, without deciding anything about the pty.
 *
 * Shared by the local close (which killed the pty already) and by a `tab:closed` broadcast
 * from the other front-end (which must not kill it a second time).
 *
 * `replaceIfEmpty` is false on the remote path on purpose: both windows reaching zero tabs
 * would otherwise each open a replacement and broadcast it, leaving two.
 */
function teardownTab(id, { replaceIfEmpty }) {
  const t = tabs.get(id);
  if (!t) return;
  try { t.disposeData?.(); } catch {}
  try { t.disposeExit?.(); } catch {}
  try { t.term.dispose(); } catch {}
  destroyRightTerminal(t);
  t.tabEl.remove();
  t.pane.remove();
  tabs.delete(id);
  state.tabs = state.tabs.filter((x) => x.id !== id);

  if (state.activeTabId === id) {
    state.activeTabId = state.tabs[0]?.id || null;
  }
  if (state.tabs.length === 0) {
    if (replaceIfEmpty) addTab();
  } else if (state.activeTabId) {
    setActive(state.activeTabId);
  }
}

// Polls every 5s in EVERY connected front-end, so both windows discover the same cwd and
// both send the same patch. The server drops the redundant one (applyTabMutation treats a
// patch that changes nothing as no change), which is what stops the two rebroadcasting at
// each other for as long as Ganglion is open.
async function syncCwds() {
  for (const t of tabs.values()) {
    try {
      const cwd = await api.ptyCwd(t.tabData.id);
      if (!cwd || cwd === t.tabData.cwd) continue;

      t.tabData.cwd = cwd;
      const patch = { cwd };

      if (t.tabData.autoName !== false) {
        try {
          const name = await api.getRepoName(t.tabData.id, cwd);
          if (name) {
            t.tabData.name = name;
            t.titleEl.textContent = name;
            patch.name = name;
          }
        } catch {}
      }

      api.tabUpdated(t.tabData.id, patch);
    } catch {}
  }
}

init();
