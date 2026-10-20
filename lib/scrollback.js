'use strict';
// Scrollback that survives a restart. A restart still kills every shell, but each pane's
// replay buffer is kept in ~/.ganglion/scrollback/<tabId>.log, so the tab comes back with
// its history above a fresh prompt.
//
// The server flushes changed buffers every few seconds and once more on SIGTERM, so a
// crash loses at most the last few seconds of output.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isTabId } = require('./message-guard');

const MAX_BYTES = 512000;

// Tab ids become file names, so anything with a path separator or a dot-dot is refused.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function scrollbackDir(home = os.homedir()) {
  return path.join(home, '.ganglion', 'scrollback');
}

function fileFor(dir, tabId) {
  if (!isTabId(tabId) || !SAFE_ID.test(tabId)) return null;
  return path.join(dir, `${tabId}.log`);
}

// Put the terminal back in a plain state after the old output, whatever the old program
// left switched on (Claude Code's full-screen view, a pager, mouse tracking), then mark
// where the new shell starts.
const RESET =
  '\x1b[?1049l' + // leave the alternate screen
  '\x1b[0m' +     // colours and attributes off
  '\x1b[?25h' +   // show the cursor
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse tracking off
  '\x1b[?2004l' + // bracketed paste off (the new shell turns it back on)
  '\x1b[?1l';     // normal cursor keys
const SEPARATOR = '\r\n\x1b[2m── restored from before restart ──\x1b[0m\r\n';

// The buffer a respawned pane starts with: the saved text, a reset, the separator.
function restoredBuffer(saved) {
  if (!saved) return '';
  const text = saved + RESET + SEPARATOR;
  return text.length > MAX_BYTES ? text.slice(-MAX_BYTES) : text;
}

function load(dir, tabId) {
  const file = fileFor(dir, tabId);
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Async write for the periodic flush. tmp + rename, so a crash mid-write leaves the
// previous copy rather than a truncated one.
async function save(dir, tabId, data) {
  const file = fileFor(dir, tabId);
  if (!file) return;
  ensureDir(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

// Sync write for shutdown, where there is no event loop left to wait on.
function saveSync(dir, tabId, data) {
  const file = fileFor(dir, tabId);
  if (!file) return;
  ensureDir(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function remove(dir, tabId) {
  const file = fileFor(dir, tabId);
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

// File names in the scrollback dir that belong to no tab in state.json. Right panes are
// saved as <tab>-right, so they're kept while their tab exists. Leftover .tmp files go too.
function orphanFiles(names, tabIds) {
  const live = new Set(tabIds);
  return names.filter((name) => {
    if (name.endsWith('.tmp')) return true;
    if (!name.endsWith('.log')) return false;
    const id = name.slice(0, -'.log'.length).replace(/-right$/, '');
    return !live.has(id);
  });
}

function prune(dir, tabIds) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const doomed = orphanFiles(names, tabIds);
  for (const name of doomed) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
  return doomed.length;
}

module.exports = {
  MAX_BYTES,
  SEPARATOR,
  scrollbackDir,
  fileFor,
  restoredBuffer,
  load,
  save,
  saveSync,
  remove,
  orphanFiles,
  prune,
};
