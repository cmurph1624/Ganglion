'use strict';
// Which leftover Ganglion files in the signal dir (/tmp) may be deleted. Pure: callers
// pass directory listings in and delete what comes back.
//
// Signal files (ganglion-<tab>[-right]-status|tool|ingest) are normally removed when a
// pane is closed or its shell exits. The boot sweep catches the rest: files for tabs that
// are no longer in state.json and haven't been touched for a day.
//
// Every Ganglion instance on the box shares /tmp, and the live server watches its files by
// path: if another instance deleted them, the live tabs' status and ingest would go dead
// silently. So the sweep is opt-in (GANGLION_SWEEP_SIGNALS=1, set only in the production
// ganglion.env), and even then it skips anything modified in the last day.
//
// Pasted images (ganglion-paste-*) are read by Claude by path, possibly some time after
// the paste, so they are kept for a day.

const SIGNAL_FILE = /^ganglion-(.+?)(-right)?-(status|tool|ingest)$/;
const PASTE_FILE = /^ganglion-paste-\d+\.[a-z0-9+.-]+$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const PASTE_MAX_AGE_MS = DAY_MS;
const SIGNAL_MIN_AGE_MS = DAY_MS;

// Signal files whose tab is not in knownTabIds and that are older than minAgeMs.
// entries: [{ name, mtimeMs }]. Empty when knownTabIds is empty.
function orphanSignalFiles(entries, knownTabIds, now, minAgeMs = SIGNAL_MIN_AGE_MS) {
  const known = new Set(knownTabIds);
  if (known.size === 0) return [];
  return entries
    .filter((e) => {
      const m = SIGNAL_FILE.exec(e.name);
      return !!m && !known.has(m[1]) && now - e.mtimeMs > minAgeMs;
    })
    .map((e) => e.name);
}

// Pasted images older than maxAgeMs. entries: [{ name, mtimeMs }].
function expiredPastes(entries, now, maxAgeMs = PASTE_MAX_AGE_MS) {
  return entries
    .filter((e) => PASTE_FILE.test(e.name) && now - e.mtimeMs > maxAgeMs)
    .map((e) => e.name);
}

module.exports = { orphanSignalFiles, expiredPastes, PASTE_MAX_AGE_MS, SIGNAL_MIN_AGE_MS };
