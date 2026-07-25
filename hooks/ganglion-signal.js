#!/usr/bin/env node
'use strict';

// Entry point invoked by every Claude Code hook:
//
//   node <repo>/hooks/ganglion-signal.js <EventName>
//
// Reads the hook JSON payload on stdin, writes the status/tool/ingest signal files that
// server.js watches, and ALWAYS exits 0. A hook that fails must never disrupt the terminal
// it is attached to, so every error here is swallowed deliberately.

const fs = require('fs');
const { signalWrites } = require('../lib/hook-signal');

const event = process.argv[2];

// Fast path: outside Ganglion there is no tab to signal, so skip reading stdin entirely.
if (!process.env.GANGLION_TAB_ID || !event) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('error', () => finish());
process.stdin.on('end', () => finish());

// Some hook events deliver no payload at all. Don't hang waiting for stdin that will never
// close -- write what we can and exit.
const guard = setTimeout(finish, 2000);
guard.unref();

let done = false;
function finish() {
  if (done) return;
  done = true;
  clearTimeout(guard);

  let payload = {};
  try {
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    // Malformed payload still deserves a status update.
  }

  try {
    for (const { file, contents } of signalWrites(event, payload, process.env)) {
      try {
        fs.writeFileSync(file, contents);
      } catch {}
    }
  } catch {}

  process.exit(0);
}
