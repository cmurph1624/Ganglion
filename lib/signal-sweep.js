'use strict';
// Which leftover Ganglion files in the signal dir (/tmp) may be deleted. Pure: callers
// pass directory listings in and delete what comes back.
//
// Signal files (ganglion-<tab>[-right]-status|tool|ingest) are normally removed when a
// pane is closed or its shell exits. The boot sweep catches the rest: files for tabs that
// are no longer in state.json. Every Ganglion instance on the box shares /tmp, so the
// sweep keys on *this* instance's tab list, and does nothing when that list is empty —
// a scratch instance (fresh HOME) must never delete the live server's files.
//
// Pasted images (ganglion-paste-*) are read by Claude by path, possibly some time after
// the paste, so they are kept for a day.

const SIGNAL_FILE = /^ganglion-(.+?)(-right)?-(status|tool|ingest)$/;
const PASTE_FILE = /^ganglion-paste-\d+\.[a-z0-9+.-]+$/i;
const PASTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Signal files whose tab is not in knownTabIds. Empty when knownTabIds is empty.
function orphanSignalFiles(filenames, knownTabIds) {
  const known = new Set(knownTabIds);
  if (known.size === 0) return [];
  return filenames.filter((name) => {
    const m = SIGNAL_FILE.exec(name);
    return !!m && !known.has(m[1]);
  });
}

// Pasted images older than maxAgeMs. entries: [{ name, mtimeMs }].
function expiredPastes(entries, now, maxAgeMs = PASTE_MAX_AGE_MS) {
  return entries
    .filter((e) => PASTE_FILE.test(e.name) && now - e.mtimeMs > maxAgeMs)
    .map((e) => e.name);
}

module.exports = { orphanSignalFiles, expiredPastes, PASTE_MAX_AGE_MS };
