const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');

const STATE_FILE = path.join(app.getPath('userData'), 'state.json');
const ptyProcesses = new Map();
const statusWatchers = new Map();

let mainWindow = null;

function sendToWindow(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 450,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  for (const p of ptyProcesses.values()) {
    try { p.kill(); } catch {}
  }
  for (const w of statusWatchers.values()) {
    try { w.close(); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});

function statusFileFor(tabId) {
  return `/tmp/ganglion-${tabId}-status`;
}

function attachStatusWatcher(tabId) {
  const file = statusFileFor(tabId);
  try {
    fs.writeFileSync(file, 'idle');
  } catch {}
  const read = () => {
    try {
      const s = fs.readFileSync(file, 'utf8').trim() || 'idle';
      sendToWindow('tab:status', { tabId, status: s });
    } catch {}
  };
  read();
  try {
    const w = fs.watch(file, { persistent: false }, () => read());
    statusWatchers.set(tabId, w);
  } catch {}
}

ipcMain.handle('state:load', () => loadState());
ipcMain.on('state:save', (_e, state) => saveState(state));

ipcMain.on('pty:spawn', (_e, { tabId, cwd }) => {
  if (ptyProcesses.has(tabId)) return;
  const shell = process.env.SHELL || '/bin/zsh';
  const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.GANGLION_TAB_ID = tabId;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';

  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env
  });
  ptyProcesses.set(tabId, p);
  p.onData((data) => {
    sendToWindow(`pty:data:${tabId}`, data);
  });
  p.onExit(() => {
    ptyProcesses.delete(tabId);
    sendToWindow(`pty:exit:${tabId}`);
  });

  if (!tabId.endsWith('-right')) attachStatusWatcher(tabId);
});

ipcMain.on('pty:write', (_e, { tabId, data }) => {
  const p = ptyProcesses.get(tabId);
  if (p) p.write(data);
});

ipcMain.on('pty:resize', (_e, { tabId, cols, rows }) => {
  const p = ptyProcesses.get(tabId);
  if (!p) return;
  try { p.resize(cols, rows); } catch {}
});

ipcMain.on('pty:kill', (_e, { tabId }) => {
  const p = ptyProcesses.get(tabId);
  if (p) {
    try { p.kill(); } catch {}
    ptyProcesses.delete(tabId);
  }
  if (!tabId.endsWith('-right')) {
    const w = statusWatchers.get(tabId);
    if (w) {
      try { w.close(); } catch {}
      statusWatchers.delete(tabId);
    }
    try { fs.unlinkSync(statusFileFor(tabId)); } catch {}
  }
});

ipcMain.handle('pty:cwd', async (_e, { tabId }) => {
  const p = ptyProcesses.get(tabId);
  if (!p) return null;
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.split('\n').find((l) => l.startsWith('n'));
      resolve(line ? line.slice(1) : null);
    });
  });
});

ipcMain.handle('file:openMarkdown', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  try {
    return { path: filePath, content: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return null;
  }
});

ipcMain.handle('file:readMarkdown', (_e, filePath) => {
  try {
    return { path: filePath, content: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return null;
  }
});
