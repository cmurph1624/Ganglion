'use strict';
// Replace a file so that readers (and a crash at any moment) see either the old contents
// or the new ones, never a truncated mix: write a temp file in the same directory, flush
// it to disk, then rename it over the target. rename() is atomic within one filesystem,
// which is why the temp file lives next to the target rather than in /tmp.

const fs = require('fs');
const path = require('path');

let counter = 0;

function writeFileAtomic(target, data, { mode } = {}) {
  // Write through a symlink rather than replacing the link with a regular file.
  let file = target;
  try { file = fs.realpathSync(target); } catch {}
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${counter++}.tmp`);
  let fd;
  try {
    // Keep the target's permissions (e.g. a 600 env file, a 664 settings file) unless told
    // otherwise. fchmod, because open()'s mode is narrowed by the umask. A new file gets
    // the usual umask-filtered default, as plain writeFileSync would.
    let fileMode = mode;
    if (fileMode === undefined) {
      try { fileMode = fs.statSync(file).mode & 0o777; } catch {}
    }
    fd = fs.openSync(tmp, 'w', fileMode === undefined ? 0o666 : fileMode);
    if (fileMode !== undefined) fs.fchmodSync(fd, fileMode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    // Persist the rename itself across a power cut. Best effort: not every platform
    // allows fsync on a directory.
    try {
      const dfd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch {}
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Read and parse a JSON file. A missing file yields `fallback`. A file that exists but
// does not parse is renamed to <file>.corrupt-<timestamp> (so the next save cannot
// silently overwrite what is left of it) and also yields `fallback`.
function readJsonOrQuarantine(file, fallback, log = console.error) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      log(`${file} did not parse (${err.message}); moved it to ${aside}`);
    } catch {
      log(`${file} did not parse (${err.message})`);
    }
    return fallback;
  }
}

module.exports = { writeFileAtomic, readJsonOrQuarantine };
