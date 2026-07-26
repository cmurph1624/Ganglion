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
const {
  resolveShell,
  shellArgs,
  signalDir,
  signalFileFor,
  cwdProbe,
  parseCwdProbe,
  INGEST_SIGNAL_PATTERN
} = require('./lib/platform');
const { createCwdTracker } = require('./lib/osc7');
const { createSizeRegistry } = require('./lib/pty-sizing');
const { serverPort } = require('./lib/server-probe');

// Distillation makes an LLM call per session to write a narrative session note into
// sessions.summary (searchable in the Memory overlay). It does NOT touch Claude Code's
// native memory files. Still opt-in (an LLM call per session): GANGLION_DISTILL_ENABLED=1.
const DISTILL_ENABLED = process.env.GANGLION_DISTILL_ENABLED === '1';
const distillDebounce = new Map();
const distillRunning = new Set();

// Shared with the desktop client (lib/server-probe.js) so the two cannot disagree about
// where Ganglion listens.
const PORT = serverPort();
// A no-op by default. It exists so the listener can later be pinned to a single interface
// (a Tailscale address, say) without another code change -- see the note about the
// unauthenticated /file route below.
const HOST = process.env.GANGLION_HOST || '0.0.0.0';
const STATE_DIR = path.join(os.homedir(), '.ganglion');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const ptyProcesses = new Map();
const ptyBuffers = new Map();
// Working directory as reported by the shell itself via OSC 7 (lib/osc7.js), one tracker
// per pty. This is the only source of cwd on Windows, where the OS cannot be asked -- see
// cwdProbe() in lib/platform.js.
const cwdTrackers = new Map();
const statusWatchers = new Map();
const clients = new Set();
// Every client's desired terminal size, keyed by the WebSocket itself. Ganglion mirrors,
// so a tab can be on screen in two places at once; the pty is sized to fit inside all of
// them. See lib/pty-sizing.js.
const sizes = createSizeRegistry();
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
  return signalFileFor(tabId, 'status');
}

function toolFileFor(tabId) {
  return signalFileFor(tabId, 'tool');
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
  return signalFileFor(tabId, 'ingest');
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
  const dir = signalDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => INGEST_SIGNAL_PATTERN.test(f));
  } catch {
    return;
  }
  for (const f of files) processIngestSignal(path.join(dir, f));
}

// Resize a pty to the size that fits inside every client currently watching it. A no-op
// when the pty is gone or no client has reported a size yet.
function applySize(tabId) {
  const p = ptyProcesses.get(tabId);
  if (!p) return;
  const size = sizes.effective(tabId);
  if (!size) return;
  try { p.resize(size.cols, size.rows); } catch {}
}

function spawnPty(ws, tabId, cwd) {
  if (ptyProcesses.has(tabId)) {
    ws.send(JSON.stringify({ type: 'pty:replay', tabId, data: ptyBuffers.get(tabId) || '' }));
    return;
  }
  const shell = resolveShell();
  const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.GANGLION_TAB_ID = tabId;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';

  const p = pty.spawn(shell, shellArgs(), {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env
  });
  ptyProcesses.set(tabId, p);
  ptyBuffers.set(tabId, '');
  const cwdTracker = createCwdTracker();
  cwdTrackers.set(tabId, cwdTracker);
  p.onData((data) => {
    const current = ptyBuffers.get(tabId) || '';
    const updated = current + data;
    ptyBuffers.set(tabId, updated.length > 512000 ? updated.slice(-512000) : updated);
    // The shell announces its directory from its prompt; read it back on the way past. The
    // sequence is left in the stream because xterm.js discards OSC it has no handler for,
    // and stripping it would mean re-scanning every chunk to no benefit.
    try { cwdTracker.push(data); } catch {}
    broadcast({ type: 'pty:data', tabId, data });
  });
  p.onExit(() => {
    ptyProcesses.delete(tabId);
    ptyBuffers.delete(tabId);
    cwdTrackers.delete(tabId);
    // Otherwise a tab id reused by a later spawn inherits the dimensions clients measured
    // against this now-dead pty.
    sizes.removeTab(tabId);
    broadcast({ type: 'pty:exit', tabId });
  });

  // The renderer fits its terminal before asking for a pty, so a size for this tab is
  // usually already on record by now. Applying it here means the shell starts at the right
  // dimensions instead of sitting at the 80x24 above until the next resize.
  applySize(tabId);

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
      // Record this client's viewport, then give the pty the size that fits inside every
      // attached client. Previously the last message won outright, so two mirrored windows
      // of different sizes overwrote each other continuously.
      sizes.set(ws, parsed.tabId, parsed.cols, parsed.rows);
      applySize(parsed.tabId);
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
      cwdTrackers.delete(tabId);
      sizes.removeTab(tabId);
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
      // What the shell told us beats what the OS can be asked. It is the only answer
      // available on Windows, and on POSIX it is the more accurate of the two anyway --
      // OSC 7 follows `cd` inside the shell, where lsof reports the pty leader's cwd.
      // Shells that do not emit OSC 7 leave this empty and fall through to the probe.
      const announced = cwdTrackers.get(parsed.tabId)?.cwd;
      if (announced) {
        ws.send(JSON.stringify({ type: 'pty:cwd:result', reqId: parsed.reqId, cwd: announced }));
        break;
      }

      const probe = cwdProbe(p.pid);
      if (!probe) {
        // No supported cwd probe on this platform (Windows) and the shell has not announced
        // yet. Answer immediately rather than spawning a command that cannot exist.
        ws.send(JSON.stringify({ type: 'pty:cwd:result', reqId: parsed.reqId, cwd: null }));
        break;
      }
      execFile(probe.command, probe.args, (err, stdout) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'pty:cwd:result', reqId: parsed.reqId, cwd: null }));
          return;
        }
        ws.send(JSON.stringify({ type: 'pty:cwd:result', reqId: parsed.reqId, cwd: parseCwdProbe(stdout) }));
      });
      break;
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('message', (msg) => handleMessage(ws, msg.toString()));
  ws.on('close', () => {
    clients.delete(ws);
    // Hand the remaining clients their space back: a small window that closes must stop
    // constraining the ptys it was watching.
    for (const tabId of sizes.removeClient(ws)) applySize(tabId);
  });
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

server.listen(PORT, HOST, () => {
  console.log(`Ganglion running at http://localhost:${PORT} (bound ${HOST})`);
});
