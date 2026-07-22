const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');
const { getDb } = require('./db/db');
const { ingestTranscript } = require('./memory/ingest');
const { indexVault, indexFile, DEFAULT_VAULT } = require('./memory/index-vault');
const memorySearch = require('./memory/search');
const distiller = require('./memory/distiller');

// Distillation makes an LLM call per session to write a narrative session note into
// sessions.summary (searchable in the Memory overlay). It does NOT touch Claude Code's
// native memory files. Still opt-in (an LLM call per session): GANGLION_DISTILL_ENABLED=1.
const DISTILL_ENABLED = process.env.GANGLION_DISTILL_ENABLED === '1';
const distillDebounce = new Map();
const distillRunning = new Set();

const PORT = process.env.PORT || 3000;
const STATE_DIR = path.join(os.homedir(), '.ganglion');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const ptyProcesses = new Map();
const ptyBuffers = new Map();
const statusWatchers = new Map();
const clients = new Set();
const ingestWatchers = new Map();
const ingestDebounce = new Map();

// Memory store. Opened eagerly; if it fails, capture is disabled but the terminal
// multiplexer keeps working.
let db = null;
try {
  db = getDb();
  console.log('Ganglion memory store ready');
} catch (err) {
  console.error('Ganglion memory store failed to open:', err.message);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'renderer')));
app.get('/xterm.css', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css')));
app.get('/xterm.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js')));
app.get('/addon-fit.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')));
app.get('/marked.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/marked/lib/marked.umd.js')));

app.post('/upload-image', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
  const ext = (req.headers['content-type'] || 'image/png').split('/')[1] || 'png';
  const filename = `ganglion-paste-${Date.now()}.${ext}`;
  const filepath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(filepath, req.body);
  res.json({ path: filepath });
});

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

function ingestFileFor(tabId) {
  return `/tmp/ganglion-${tabId}-ingest`;
}

// Read a signal payload written by a Stop/SessionEnd hook and ingest the referenced
// transcript. Errors are swallowed so a bad signal never disrupts the terminal.
function processIngestSignal(file) {
  if (!db) return;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath) return;
  try {
    const { sessionId, added } = ingestTranscript(db, transcriptPath);
    if (added > 0) {
      broadcast({ type: 'memory:ingested', sessionId, added });
      maybeDistill(sessionId);
    }
  } catch (err) {
    console.error('ingest failed:', err.message);
  }
}

// Fire-and-forget distillation, debounced per session so a burst of Stops collapses
// into one run, and guarded against overlapping runs for the same session.
function maybeDistill(sessionId) {
  if (!DISTILL_ENABLED || !db || !sessionId) return;
  clearTimeout(distillDebounce.get(sessionId));
  distillDebounce.set(
    sessionId,
    setTimeout(() => {
      if (distillRunning.has(sessionId)) return;
      distillRunning.add(sessionId);
      distiller
        .distillSession(db, sessionId)
        .then((r) => {
          if (r.updated) {
            console.log(`wrote session note (${r.chars} chars) for session ${sessionId}`);
            broadcast({ type: 'memory:distilled', sessionId });
          }
        })
        .catch((err) => console.error('distill failed:', err.message))
        .finally(() => distillRunning.delete(sessionId));
    }, 3000)
  );
}

function attachIngestWatcher(tabId) {
  const file = ingestFileFor(tabId);
  const fire = () => {
    clearTimeout(ingestDebounce.get(tabId));
    ingestDebounce.set(tabId, setTimeout(() => processIngestSignal(file), 500));
  };
  // Drain anything already written (e.g. a Stop that fired before this watcher existed).
  if (fs.existsSync(file)) fire();
  try {
    const w = fs.watch(file, { persistent: false }, () => fire());
    ingestWatchers.set(tabId, w);
  } catch {
    // File may not exist yet; retry attaching once it appears via a lightweight poll.
    const iv = setInterval(() => {
      if (!fs.existsSync(file)) return;
      clearInterval(iv);
      try {
        const w = fs.watch(file, { persistent: false }, () => fire());
        ingestWatchers.set(tabId, w);
      } catch {}
      fire();
    }, 1000);
    ingestWatchers.set(tabId, { close: () => clearInterval(iv) });
  }
}

function detachIngestWatcher(tabId) {
  const w = ingestWatchers.get(tabId);
  if (w) {
    try { w.close(); } catch {}
    ingestWatchers.delete(tabId);
  }
  clearTimeout(ingestDebounce.get(tabId));
  ingestDebounce.delete(tabId);
  try { fs.unlinkSync(ingestFileFor(tabId)); } catch {}
}

// Watch the Obsidian vault so edits show up in recall promptly. Node's recursive
// fs.watch is supported on Linux; a full mtime-incremental sweep runs first to catch
// anything changed while the server was down.
let vaultWatcher = null;
const vaultDebounce = new Map();
function startVaultWatcher() {
  if (!db || !fs.existsSync(DEFAULT_VAULT)) return;
  // Catch-up sweep off the hot path.
  setImmediate(() => {
    try { indexVault(db); } catch (err) { console.error('vault sweep failed:', err.message); }
  });
  try {
    vaultWatcher = fs.watch(DEFAULT_VAULT, { persistent: false, recursive: true }, (_evt, rel) => {
      if (!rel || !rel.endsWith('.md')) return;
      const abs = path.join(DEFAULT_VAULT, rel);
      clearTimeout(vaultDebounce.get(abs));
      vaultDebounce.set(
        abs,
        setTimeout(() => {
          try { indexFile(db, abs); } catch (err) { console.error('vault index failed:', err.message); }
        }, 1000)
      );
    });
  } catch (err) {
    console.error('vault watcher unavailable (recursive fs.watch failed):', err.message);
  }
}

// On boot, drain any ingest signals left behind while the server was down.
function drainIngestSignals() {
  if (!db) return;
  let files;
  try {
    files = fs.readdirSync('/tmp').filter((f) => /^ganglion-.*-ingest$/.test(f));
  } catch {
    return;
  }
  for (const f of files) processIngestSignal(path.join('/tmp', f));
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

  if (!tabId.endsWith('-right')) {
    attachStatusWatcher(tabId);
    attachIngestWatcher(tabId);
  }
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
        detachIngestWatcher(tabId);
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
    case 'memory:search': {
      let results = [];
      try {
        if (db) results = memorySearch.search(db, parsed.params || {});
      } catch (err) {
        console.error('memory:search failed:', err.message);
      }
      ws.send(JSON.stringify({ type: 'memory:search:result', reqId: parsed.reqId, results }));
      break;
    }
    case 'memory:getSession': {
      let data = null;
      try {
        if (db) data = memorySearch.getSession(db, parsed.sessionId);
      } catch (err) {
        console.error('memory:getSession failed:', err.message);
      }
      ws.send(JSON.stringify({ type: 'memory:getSession:result', reqId: parsed.reqId, data }));
      break;
    }
    case 'memory:getTurn': {
      let data = null;
      try {
        if (db) data = memorySearch.getTurn(db, parsed.uuid, parsed.context);
      } catch (err) {
        console.error('memory:getTurn failed:', err.message);
      }
      ws.send(JSON.stringify({ type: 'memory:getTurn:result', reqId: parsed.reqId, data }));
      break;
    }
    case 'memory:projects': {
      let projects = [];
      try {
        if (db) projects = db.prepare('SELECT DISTINCT project_slug FROM sessions ORDER BY project_slug').all().map((r) => r.project_slug);
      } catch (err) {
        console.error('memory:projects failed:', err.message);
      }
      ws.send(JSON.stringify({ type: 'memory:projects:result', reqId: parsed.reqId, projects }));
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
  for (const iw of ingestWatchers.values()) {
    try { iw.close(); } catch {}
  }
  if (vaultWatcher) {
    try { vaultWatcher.close(); } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

drainIngestSignals();
startVaultWatcher();

server.listen(PORT, () => {
  console.log(`Ganglion running at http://localhost:${PORT}`);
});
