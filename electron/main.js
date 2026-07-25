'use strict';

// Ganglion desktop shell.
//
// This is a WINDOW, not an application. It owns exactly three things: a native
// BrowserWindow, its remembered bounds, and a native file dialog. Every pty, every byte of
// state, and the whole memory store stay in server.js under pm2 -- which is what lets a
// browser on the Mac and this window be open at the same time, mirroring the same tabs.
//
// Two rules keep that true, and both are load-bearing:
//
//   1. NEVER require node-pty, better-sqlite3, db/ or memory/ from here. Because this
//      process loads no native module, there is no electron-rebuild step and no ABI
//      coupling to the server -- the single biggest simplification over the original
//      Electron build, whose README still tells you to rebuild node-pty.
//
//   2. NEVER spawn a server. pm2 owns the lifecycle. If this process started one it would
//      race the pm2 instance for the port, and closing the window would kill ptys the
//      browser is still using.
//
// Run it with `npm run desktop`, i.e. `electron electron/main.js`. Never `electron .` --
// that resolves package.json's "main", which is server.js, and would boot Express inside
// Electron.

const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { serverUrl, probeServer } = require('../lib/server-probe');
const { normalizeBounds, boundsToSave, MIN_WIDTH, MIN_HEIGHT } = require('../lib/window-bounds');

const TARGET_URL = serverUrl();
// Alongside state.json and memory.db rather than Electron's userData: all Ganglion state
// belongs in one directory, and this file is the desktop client's alone.
const BOUNDS_FILE = path.join(os.homedir(), '.ganglion', 'window.json');
// Matches renderer/client.js's reconnect cadence, so a server coming back feels equally
// responsive whether the window is showing the app or the retry screen.
const RETRY_INTERVAL_MS = 2000;

let mainWindow = null;
let retryTimer = null;

// --- bounds -----------------------------------------------------------------------------

function readSavedBounds() {
  try {
    return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeSavedBounds(win) {
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds(), not getBounds(): a maximized window reports the screen size, and
    // persisting that would lose the size to restore down to.
    const payload = boundsToSave(win.getNormalBounds(), win.isMaximized());
    fs.mkdirSync(path.dirname(BOUNDS_FILE), { recursive: true });
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(payload, null, 2));
  } catch {
    // A window that cannot remember where it was is not worth failing to close over.
  }
}

// --- window ------------------------------------------------------------------------------

function createWindow() {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const bounds = normalizeBounds(readSavedBounds(), displays);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#1e1e1e',
    // Deferred until the first paint, so the app never flashes white over the dark UI.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload needs nothing but contextBridge and ipcRenderer, both of which survive
      // sandboxing. The legacy main.js disabled the sandbox; nothing here requires that.
      sandbox: true,
      spellcheck: false
    }
  });

  if (bounds.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => writeSavedBounds(mainWindow));
  mainWindow.on('closed', () => {
    stopRetryLoop();
    mainWindow = null;
  });

  hardenNavigation(mainWindow);
  installKeyPolicy(mainWindow);

  // A precision touchpad pinch would otherwise scale the terminal grid.
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
    // -3 is ABORTED, which a normal in-page navigation produces; subframe failures are
    // the markdown pane's business, not ours.
    if (!isMainFrame || errorCode === -3) return;
    showRetry();
  });

  return mainWindow;
}

// The markdown pane renders `marked` output containing real <a href>. In a window with no
// browser chrome, following one replaces the entire app and there is no back button.
function hardenNavigation(win) {
  const isInternal = (url) => {
    try {
      return new URL(url).origin === new URL(TARGET_URL).origin;
    } catch {
      return false;
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    // file:// is the retry screen navigating to itself; anything off-origin goes to the
    // real browser.
    if (isInternal(url) || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

// Keyboard policy is deliberately subtractive.
//
// The whole point of the desktop client is that Ctrl+W, Ctrl+T, Ctrl+L, Ctrl+P, Ctrl+F,
// Ctrl+R and F5 reach the shell instead of being eaten by browser chrome. A default
// Electron menu would undo that: menu roles bind Ctrl+A/W/R/Q/N/X/Z/Y, and accelerators
// are handled in the browser process BEFORE the page sees the key -- silently breaking
// readline's kill-word, reverse-i-search and select-all.
//
// So: no menu at all, plus a tiny allow-list of keys no terminal wants. Clipboard keys are
// NOT listed -- Chromium's built-in editing shortcuts keep working without a menu, and
// renderer.js deliberately lets Ctrl+V and Ctrl+Shift+C through to the browser. Ctrl+K is
// not listed either; renderer/memory-panel.js owns it.
function installKeyPolicy(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();

    if (key === 'f12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (key === 'f11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.control && input.shift && key === 'r') {
      win.webContents.reloadIgnoringCache();
      event.preventDefault();
    }
  });
}

// --- attach / retry ------------------------------------------------------------------------

function stopRetryLoop() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

function startRetryLoop() {
  stopRetryLoop();
  retryTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return stopRetryLoop();
    if (await probeServer(TARGET_URL)) {
      stopRetryLoop();
      mainWindow.loadURL(TARGET_URL);
    }
  }, RETRY_INTERVAL_MS);
}

function showRetry() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // A standalone page, NOT renderer/index.html over file://. Under file:// there is no
  // location.host, so client.js's `ws://${location.host}` would fail and the app would
  // look broken rather than disconnected.
  mainWindow.loadFile(path.join(__dirname, 'retry.html'), { query: { url: TARGET_URL } });
  startRetryLoop();
}

async function attach() {
  if (await probeServer(TARGET_URL)) {
    mainWindow.loadURL(TARGET_URL);
  } else {
    showRetry();
  }
}

// Note what is deliberately absent: no handler for the server dying while the app is
// loaded. renderer/client.js already reconnects every 2s and replays its scrollback via
// state:load. Taking the page over here would fight that and lose the buffer.

// --- ipc -------------------------------------------------------------------------------

ipcMain.handle('desktop:openMarkdown', async (_event, defaultPath) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  // A path only. The renderer already knows how to fetch /file?path=, so shipping the
  // file's contents through IPC would duplicate a route that works.
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('desktop:retry', async () => {
  const alive = await probeServer(TARGET_URL);
  if (alive && mainWindow && !mainWindow.isDestroyed()) {
    stopRetryLoop();
    mainWindow.loadURL(TARGET_URL);
  }
  return alive;
});

// --- lifecycle ---------------------------------------------------------------------------

// Electron is launched with a script path rather than a directory, so there is no app
// manifest to read a name from. setAppUserModelId is not cosmetic: renderer.js raises HTML
// Notifications when a tab needs input, and Windows silently drops them without one.
app.setName('Ganglion');
app.setAppUserModelId('com.stigmergylabs.ganglion');

// Do this before any window exists, so no default accelerator is ever live.
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  attach();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      attach();
    }
  });
});

app.on('window-all-closed', () => {
  // Closing this window must be exactly as harmless as closing a browser tab. The legacy
  // main.js killed every pty here; doing that now would tear down sessions the Mac is
  // still attached to.
  stopRetryLoop();
  app.quit();
});
