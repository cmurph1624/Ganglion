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
const { indexVault, indexFile, resolveVault } = require('./memory/index-vault');
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
const { createSizeRegistry } = require('./lib/pty-sizing');
const { serverPort } = require('./lib/server-probe');
const { writeFileAtomic, readJsonOrQuarantine } = require('./lib/atomic-write');
const { END_DELAY_MS, idleDelayMs, scheduleOnIngest, shouldRunNow } = require('./lib/distill-schedule');
const { buildAllowedHosts, httpGuard, wsVerifier } = require('./lib/request-guard');
const { parseMessage, isTabId, isSavableState } = require('./lib/message-guard');
const { orphanSignalFiles, expiredPastes } = require('./lib/signal-sweep');
const { alertConfig, createAlerter, alertMessage, publishNtfy } = require('./lib/phone-alerts');
const scrollback = require('./lib/scrollback');

// Distillation makes an LLM call to write a narrative session note into sessions.summary
// (searchable in the Memory overlay). It does NOT touch Claude Code's native memory files.
// Opt-in: GANGLION_DISTILL_ENABLED=1. When it runs is decided by lib/distill-schedule.js:
// once a session has been quiet for GANGLION_DISTILL_IDLE_MIN (default 10), or soon after
// SessionEnd — not after every reply.
const DISTILL_ENABLED = process.env.GANGLION_DISTILL_ENABLED === '1';
const DISTILL_IDLE_MS = idleDelayMs();
const distillTimers = new Map();      // sessionId -> pending timeout
const distillRunning = new Set();

// Shared with the desktop client (lib/server-probe.js) so the two cannot disagree about
// where Ganglion listens.
// PORT=0 (ephemeral, used by the integration tests) is honoured here rather than in
// serverPort(), which maps 0 to the default for clients that must know the port.
const PORT = process.env.PORT === '0' ? 0 : serverPort();
// A no-op by default. It exists so the listener can later be pinned to a single interface
// (a Tailscale address, say) without another code change -- see the note about the
// unauthenticated /file route below.
const HOST = process.env.GANGLION_HOST || '0.0.0.0';
const STATE_DIR = path.join(os.homedir(), '.ganglion');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const ptyProcesses = new Map();
const ptyBuffers = new Map();
// Scrollback kept on disk across restarts (lib/scrollback.js). Buffers that changed since
// the last flush are written every 30s (a busy Claude pane is dirty nonstop, and each
// flush rewrites up to 512KB); shuttingDown stops the exit handlers that
// SIGTERM sets off from deleting the files the shutdown flush just wrote.
const SCROLLBACK_DIR = scrollback.scrollbackDir();
const SCROLLBACK_FLUSH_MS = 30000;
const dirtyBuffers = new Set();
let shuttingDown = false;
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
// Refuse other websites: see lib/request-guard.js. Must run before every route.
const allowedHosts = buildAllowedHosts();
const wss = new WebSocketServer({ server, verifyClient: wsVerifier(allowedHosts) });

app.use(httpGuard(allowedHosts));
app.use(express.static(path.join(__dirname, 'renderer')));
app.get('/xterm.css', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css')));
app.get('/xterm.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js')));
app.get('/addon-fit.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')));
app.get('/addon-search.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-search/lib/addon-search.js')));
app.get('/purify.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.js')));
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
  return readJsonOrQuarantine(STATE_FILE, { tabs: [], activeTabId: null });
}

// Atomic, so a crash or restart mid-save can't leave a truncated state.json (which used
// to load as an empty tab list and then be overwritten by the next save).
function saveState(state) {
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

// Phone alerts (lib/phone-alerts.js). Off unless GANGLION_NTFY_URL is set.
const ALERTS = alertConfig();
const alerter = ALERTS && createAlerter({
  delayMs: ALERTS.delayMs,
  doneAfterMs: ALERTS.doneAfterMs,
  send: (alert) => {
    // Looked up at send time so a rename since the status change is picked up.
    const tab = (loadState().tabs || []).find((t) => t && t.id === alert.tabId);
    publishNtfy(ALERTS, alertMessage(alert, tab && tab.name));
  },
});
if (ALERTS) console.log(`phone alerts on (delay ${ALERTS.delayMs / 1000}s, done after ${ALERTS.doneAfterMs / 60000} min)`);

function statusFileFor(tabId) {
  return signalFileFor(tabId, 'status');
}

function toolFileFor(tabId) {
  return signalFileFor(tabId, 'tool');
}

const toolWatchers = new Map();

function attachStatusWatcher(tabId) {
  // A respawned pty (same tab id) must not leave the previous watchers running: they
  // would broadcast every status change twice.
  closeStatusWatchers(tabId);
  const file = statusFileFor(tabId);
  try {
    fs.writeFileSync(file, 'idle');
  } catch {}
  const read = () => {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const s = raw || 'idle';
      broadcast({ type: 'tab:status', tabId, status: s });
      // An empty read is a hook write caught mid-truncate, not a real status: feeding it
      // in as idle would reset the run and suppress the next alert.
      if (alerter && raw) alerter.onStatus(tabId, raw);
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

function closeStatusWatchers(tabId) {
  for (const map of [statusWatchers, toolWatchers]) {
    const w = map.get(tabId);
    if (w) {
      try { w.close(); } catch {}
      map.delete(tabId);
    }
  }
}

// Pane closed or its shell exited: stop watching and remove the status/tool files.
function detachStatusWatchers(tabId) {
  closeStatusWatchers(tabId);
  if (alerter) alerter.forget(tabId);
  try { fs.unlinkSync(statusFileFor(tabId)); } catch {}
  try { fs.unlinkSync(toolFileFor(tabId)); } catch {}
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
    if (added > 0) broadcast({ type: 'memory:ingested', sessionId, added });
    maybeDistill(sessionId, payload.event, added);
  } catch (err) {
    console.error('ingest failed:', err.message);
  }
}

function sessionTurnInfo(sessionId) {
  const row = db
    .prepare('SELECT turn_count, summary, distilled_turns FROM sessions WHERE session_id = ?')
    .get(sessionId);
  return {
    turnCount: row ? row.turn_count || 0 : 0,
    hasSummary: !!(row && row.summary),
    distilledTurns: row && row.distilled_turns != null ? row.distilled_turns : undefined,
  };
}

// Called for every ingest signal. Restarts the session's idle timer on new turns, or runs
// soon after SessionEnd; see lib/distill-schedule.js.
function maybeDistill(sessionId, event, added) {
  if (!DISTILL_ENABLED || !db || !sessionId) return;
  const when = scheduleOnIngest({ event, added, ...sessionTurnInfo(sessionId) });
  if (!when) return;
  clearTimeout(distillTimers.get(sessionId));
  distillTimers.set(
    sessionId,
    setTimeout(() => runDistill(sessionId), when === 'end' ? END_DELAY_MS : DISTILL_IDLE_MS)
  );
}

function runDistill(sessionId) {
  distillTimers.delete(sessionId);
  if (distillRunning.has(sessionId)) {
    // A run is in flight. Check again after it, rather than dropping this trigger: after a
    // SessionEnd no further Stop will come along to retry it. shouldRunNow then skips the
    // re-check if the in-flight run already covered every turn.
    distillTimers.set(sessionId, setTimeout(() => runDistill(sessionId), END_DELAY_MS));
    return;
  }
  const { turnCount, distilledTurns } = sessionTurnInfo(sessionId);
  if (!shouldRunNow({ turnCount, distilledTurns })) return;
  distillRunning.add(sessionId);
  distiller
    .distillSession(db, sessionId)
    .then((r) => {
      // Covered either way: a "(no note)" answer must not be retried on every idle, or
      // after every restart, so this is stored, not kept in memory.
      db.prepare('UPDATE sessions SET distilled_turns = ? WHERE session_id = ?').run(turnCount, sessionId);
      if (r.updated) {
        console.log(`wrote session note (${r.chars} chars) for session ${sessionId}`);
        broadcast({ type: 'memory:distilled', sessionId });
      }
    })
    .catch((err) => console.error('distill failed:', err.message))
    .finally(() => distillRunning.delete(sessionId));
}

function attachIngestWatcher(tabId) {
  // A respawned pty (same tab id) must not leave the previous watcher running alongside
  // the new one. Close it, but keep the signal file: it may hold a Stop not yet drained.
  const prev = ingestWatchers.get(tabId);
  if (prev) {
    try { prev.close(); } catch {}
    ingestWatchers.delete(tabId);
  }
  clearTimeout(ingestDebounce.get(tabId));
  const file = ingestFileFor(tabId);
  const fire = () => {
    clearTimeout(ingestDebounce.get(tabId));
    ingestDebounce.set(tabId, setTimeout(() => {
      ingestDebounce.delete(tabId);
      processIngestSignal(file);
    }, 500));
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
  // The last Stop/SessionEnd may still be inside the 500ms debounce; ingest it before the
  // file goes. Ingest is incremental, so re-reading an already-processed signal is a no-op.
  const file = ingestFileFor(tabId);
  if (fs.existsSync(file)) processIngestSignal(file);
  try { fs.unlinkSync(file); } catch {}
}

// Watch the Obsidian vault so edits show up in recall promptly. Node's recursive
// fs.watch is supported on Linux; a full mtime-incremental sweep runs first to catch
// anything changed while the server was down.
let vaultWatcher = null;
const vaultDebounce = new Map();
// retrying: called again after a watcher error. Then a missing vault (moved, mid-sync,
// unmounted) is checked again every minute until it's back; at boot a missing vault just
// means this box has none, so nothing polls.
function startVaultWatcher({ retrying = false } = {}) {
  const vaultRoot = resolveVault();
  if (!db) return;
  if (!fs.existsSync(vaultRoot)) {
    if (retrying) setTimeout(() => startVaultWatcher({ retrying: true }), 60 * 1000).unref();
    return;
  }
  // Catch-up sweep off the hot path.
  setImmediate(() => {
    try {
      const r = indexVault(db, { vaultRoot });
      console.log(`vault ${vaultRoot}: ${r.scanned} notes, ${r.indexed} (re)indexed`);
    } catch (err) {
      console.error('vault sweep failed:', err.message);
    }
  });
  try {
    vaultWatcher = fs.watch(vaultRoot, { persistent: false, recursive: true }, (_evt, rel) => {
      if (!rel || !rel.endsWith('.md')) return;
      const abs = path.join(vaultRoot, rel);
      clearTimeout(vaultDebounce.get(abs));
      vaultDebounce.set(
        abs,
        setTimeout(() => {
          vaultDebounce.delete(abs);
          try { indexFile(db, abs, vaultRoot); } catch (err) { console.error('vault index failed:', err.message); }
        }, 1000)
      );
    });
    // Without a listener, a watcher 'error' (vault moved or deleted, a new folder that
    // can't be watched, inotify limit reached) is thrown and kills the server and every pty.
    // Log it, stop watching, and try again every minute until the vault is back; the sweep
    // in startVaultWatcher catches up on anything missed meanwhile.
    vaultWatcher.on('error', (err) => {
      console.error('vault watcher failed, retrying in 60s:', err.message);
      try { vaultWatcher.close(); } catch {}
      vaultWatcher = null;
      setTimeout(() => startVaultWatcher({ retrying: true }), 60 * 1000).unref();
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

// Remove signal files of tabs that no longer exist, and pasted images older than a day.
// See lib/signal-sweep.js for why this keys on this instance's own tab list.
function sweepSignalDir({ signals }) {
  const dir = signalDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const entries = [];
  for (const name of names) {
    if (!name.startsWith('ganglion-')) continue;
    try { entries.push({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }); } catch {}
  }
  const now = Date.now();
  const doomed = expiredPastes(entries, now);
  if (signals) {
    const tabIds = (loadState().tabs || []).map((t) => t && t.id).filter(Boolean);
    doomed.push(...orphanSignalFiles(entries, tabIds, now));
  }
  for (const name of doomed) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
  if (doomed.length) console.log(`removed ${doomed.length} stale file(s) from ${dir}`);
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

// Tab closed or its shell exited: its scrollback has no tab to come back to.
function forgetScrollback(tabId) {
  dirtyBuffers.delete(tabId);
  scrollback.remove(SCROLLBACK_DIR, tabId);
}

let flushing = false;
async function flushScrollback() {
  if (flushing || shuttingDown) return;
  flushing = true;
  try {
    for (const tabId of [...dirtyBuffers]) {
      dirtyBuffers.delete(tabId);
      const buf = ptyBuffers.get(tabId);
      if (buf === undefined) continue;
      try {
        await scrollback.save(SCROLLBACK_DIR, tabId, buf);
      } catch (err) {
        console.error('scrollback save failed:', err.message);
      }
      // Closed while the write was in flight: don't leave its file behind.
      if (!ptyBuffers.has(tabId)) scrollback.remove(SCROLLBACK_DIR, tabId);
    }
  } finally {
    flushing = false;
  }
}

function flushScrollbackSync() {
  for (const [tabId, buf] of ptyBuffers) {
    if (!buf) continue;
    try { scrollback.saveSync(SCROLLBACK_DIR, tabId, buf); } catch (err) {
      console.error('scrollback save failed:', err.message);
    }
  }
}

function spawnPty(ws, tabId, cwd) {
  if (!isTabId(tabId)) return;
  if (ptyProcesses.has(tabId)) {
    ws.send(JSON.stringify({ type: 'pty:replay', tabId, data: ptyBuffers.get(tabId) || '' }));
    return;
  }
  const shell = resolveShell();
  const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  const env = { ...process.env };
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
  // A pane that had output before a restart starts with it, above the new shell.
  const restored = scrollback.restoredBuffer(scrollback.load(SCROLLBACK_DIR, tabId));
  ptyBuffers.set(tabId, restored);
  if (restored) {
    dirtyBuffers.add(tabId);
    ws.send(JSON.stringify({ type: 'pty:replay', tabId, data: restored }));
  }
  p.onData((data) => {
    const current = ptyBuffers.get(tabId) || '';
    const updated = current + data;
    const max = scrollback.MAX_BYTES;
    ptyBuffers.set(tabId, updated.length > max ? updated.slice(-max) : updated);
    dirtyBuffers.add(tabId);
    broadcast({ type: 'pty:data', tabId, data });
  });
  p.onExit(() => {
    // Only clean up if this is still the tab's pty. After pty:kill the entry is already
    // gone; if a new pty took the id, its state and watchers are not ours to remove.
    const current = ptyProcesses.get(tabId);
    if (current && current !== p) return;
    if (shuttingDown) return;
    if (!tabId.endsWith('-right')) detachStatusWatchers(tabId);
    detachIngestWatcher(tabId);
    ptyProcesses.delete(tabId);
    ptyBuffers.delete(tabId);
    forgetScrollback(tabId);
    // Otherwise a tab id reused by a later spawn inherits the dimensions clients measured
    // against this now-dead pty.
    sizes.removeTab(tabId);
    broadcast({ type: 'pty:exit', tabId });
  });

  // The renderer fits its terminal before asking for a pty, so a size for this tab is
  // usually already on record by now. Applying it here means the shell starts at the right
  // dimensions instead of sitting at the 80x24 above until the next resize.
  applySize(tabId);

  // Every pane can run Claude Code, so every pane's transcripts get ingested. Only the
  // left pane drives the tab's status dot, so the right split gets no status watcher.
  if (!tabId.endsWith('-right')) attachStatusWatcher(tabId);
  attachIngestWatcher(tabId);
}

// One bad message must not take the server down: a crash kills every pty.
function handleMessage(ws, msg) {
  try {
    dispatchMessage(ws, msg);
  } catch (err) {
    console.error('message handler failed:', err && err.stack ? err.stack : err);
  }
}

function dispatchMessage(ws, msg) {
  const parsed = parseMessage(msg);
  if (!parsed) return;

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
      // A missing or non-object state would overwrite state.json with garbage.
      if (!isSavableState(parsed.state)) break;
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
      if (!isTabId(tabId)) break;
      const p = ptyProcesses.get(tabId);
      if (p) {
        try { p.kill(); } catch {}
        ptyProcesses.delete(tabId);
      }
      ptyBuffers.delete(tabId);
      forgetScrollback(tabId);
      sizes.removeTab(tabId);
      if (!tabId.endsWith('-right')) detachStatusWatchers(tabId);
      detachIngestWatcher(tabId);
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
      const probe = cwdProbe(p.pid);
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
  // Without a listener, a socket 'error' event is thrown and crashes the server.
  ws.on('error', (err) => console.error('websocket error:', err.message));
  ws.on('message', (msg) => handleMessage(ws, msg.toString()));
  ws.on('close', () => {
    clients.delete(ws);
    // Hand the remaining clients their space back: a small window that closes must stop
    // constraining the ptys it was watching.
    for (const tabId of sizes.removeClient(ws)) applySize(tabId);
  });
});

function cleanup() {
  // Save scrollback before the ptys go: killing them fires their exit handlers.
  shuttingDown = true;
  flushScrollbackSync();
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
// Deleting other tabs' signal files is only safe in the production instance: another
// instance sharing /tmp would kill the live server's watchers. See lib/signal-sweep.js.
sweepSignalDir({ signals: process.env.GANGLION_SWEEP_SIGNALS === '1' });
// Pastes keep arriving while the server runs; tab signal files are handled by kill/exit.
setInterval(() => sweepSignalDir({ signals: false }), 60 * 60 * 1000).unref();
startVaultWatcher();

// Drop saved scrollback for tabs that no longer exist. Skipped when state.json has no
// tabs, so a lost or quarantined state file doesn't take every tab's history with it.
{
  const tabIds = (loadState().tabs || []).map((t) => t && t.id).filter(Boolean);
  if (tabIds.length) {
    const n = scrollback.prune(SCROLLBACK_DIR, tabIds);
    if (n) console.log(`removed ${n} stale scrollback file(s)`);
  }
}
setInterval(() => { flushScrollback(); }, SCROLLBACK_FLUSH_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`Ganglion running at http://localhost:${server.address().port} (bound ${HOST})`);
});
