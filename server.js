const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');

const PORT = process.env.PORT || 3000;
const STATE_DIR = path.join(os.homedir(), '.ganglion');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const ptyProcesses = new Map();
const ptyBuffers = new Map();
const statusWatchers = new Map();
const clients = new Set();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'renderer')));
app.get('/xterm.css', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css')));
app.get('/xterm.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js')));
app.get('/addon-fit.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')));
app.get('/marked.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/marked/lib/marked.umd.js')));

app.get('/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('Missing path parameter');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(404).send(`Cannot read file: ${err.message}`);
  }
});

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(json);
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

function statusFileFor(tabId) {
  return `/tmp/ganglion-${tabId}-status`;
}

function toolFileFor(tabId) {
  return `/tmp/ganglion-${tabId}-tool`;
}

const toolWatchers = new Map();

function attachStatusWatcher(tabId) {
  const file = statusFileFor(tabId);
  try {
    fs.writeFileSync(file, 'idle');
  } catch {}
  const read = () => {
    try {
      const s = fs.readFileSync(file, 'utf8').trim() || 'idle';
      broadcast({ type: 'tab:status', tabId, status: s });
    } catch {}
  };
  read();
  try {
    const w = fs.watch(file, { persistent: false }, () => read());
    statusWatchers.set(tabId, w);
  } catch {}

  const toolFile = toolFileFor(tabId);
  try { fs.writeFileSync(toolFile, ''); } catch {}
  const readTool = () => {
    try {
      const tool = fs.readFileSync(toolFile, 'utf8').trim();
      broadcast({ type: 'tab:tool', tabId, tool });
    } catch {}
  };
  try {
    const tw = fs.watch(toolFile, { persistent: false }, () => readTool());
    toolWatchers.set(tabId, tw);
  } catch {}
}

function spawnPty(ws, tabId, cwd) {
  if (ptyProcesses.has(tabId)) {
    ws.send(JSON.stringify({ type: 'pty:replay', tabId, data: ptyBuffers.get(tabId) || '' }));
    return;
  }
  const shell = process.env.SHELL || '/bin/bash';
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
  ptyBuffers.set(tabId, '');
  p.onData((data) => {
    const current = ptyBuffers.get(tabId) || '';
    const updated = current + data;
    ptyBuffers.set(tabId, updated.length > 512000 ? updated.slice(-512000) : updated);
    broadcast({ type: 'pty:data', tabId, data });
  });
  p.onExit(() => {
    ptyProcesses.delete(tabId);
    ptyBuffers.delete(tabId);
    broadcast({ type: 'pty:exit', tabId });
  });

  if (!tabId.endsWith('-right')) attachStatusWatcher(tabId);
}

function handleMessage(ws, msg) {
  let parsed;
  try {
    parsed = JSON.parse(msg);
  } catch {
    return;
  }

  switch (parsed.type) {
    case 'state:load': {
      const state = loadState();
      ws.send(JSON.stringify({ type: 'state:loaded', reqId: parsed.reqId, state }));
      for (const [tabId, buf] of ptyBuffers) {
        if (buf) ws.send(JSON.stringify({ type: 'pty:replay', tabId, data: buf }));
      }
      break;
    }
    case 'state:save': {
      saveState(parsed.state);
      break;
    }
    case 'pty:spawn': {
      spawnPty(ws, parsed.tabId, parsed.cwd);
      break;
    }
    case 'pty:write': {
      const p = ptyProcesses.get(parsed.tabId);
      if (p) p.write(parsed.data);
      break;
    }
    case 'pty:resize': {
      const p = ptyProcesses.get(parsed.tabId);
      if (!p) break;
      try { p.resize(parsed.cols, parsed.rows); } catch {}
      break;
    }
    case 'pty:kill': {
      const tabId = parsed.tabId;
      const p = ptyProcesses.get(tabId);
      if (p) {
        try { p.kill(); } catch {}
        ptyProcesses.delete(tabId);
      }
      ptyBuffers.delete(tabId);
      if (!tabId.endsWith('-right')) {
        const w = statusWatchers.get(tabId);
        if (w) {
          try { w.close(); } catch {}
          statusWatchers.delete(tabId);
        }
        try { fs.unlinkSync(statusFileFor(tabId)); } catch {}
        const tw = toolWatchers.get(tabId);
        if (tw) {
          try { tw.close(); } catch {}
          toolWatchers.delete(tabId);
        }
        try { fs.unlinkSync(toolFileFor(tabId)); } catch {}
      }
      break;
    }
    case 'pty:reponame': {
      const cwd = parsed.cwd;
      if (!cwd) {
        ws.send(JSON.stringify({ type: 'pty:reponame:result', reqId: parsed.reqId, name: null }));
        break;
      }
      let dir = cwd;
      const home = os.homedir();
      let repoName = null;
      while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) {
          repoName = path.basename(dir);
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir || dir === home) break;
        dir = parent;
      }
      if (!repoName) repoName = path.basename(cwd);
      ws.send(JSON.stringify({ type: 'pty:reponame:result', reqId: parsed.reqId, name: repoName }));
      break;
    }
    case 'pty:cwd': {
      const p = ptyProcesses.get(parsed.tabId);
      if (!p) {
        ws.send(JSON.stringify({ type: 'pty:cwd:result', reqId: parsed.reqId, cwd: null }));
        break;
      }
      execFile('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], (err, stdout) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'pty:cwd:result', reqId: parsed.reqId, cwd: null }));
          return;
        }
        const line = stdout.split('\n').find((l) => l.startsWith('n'));
        ws.send(JSON.stringify({ type: 'pty:cwd:result', reqId: parsed.reqId, cwd: line ? line.slice(1) : null }));
      });
      break;
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('message', (msg) => handleMessage(ws, msg.toString()));
  ws.on('close', () => clients.delete(ws));
});

function cleanup() {
  for (const p of ptyProcesses.values()) {
    try { p.kill(); } catch {}
  }
  for (const w of statusWatchers.values()) {
    try { w.close(); } catch {}
  }
  for (const tw of toolWatchers.values()) {
    try { tw.close(); } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

server.listen(PORT, () => {
  console.log(`Ganglion running at http://localhost:${PORT}`);
});
