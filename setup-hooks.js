#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeFileAtomic } = require('./lib/atomic-write');

const hooksFile = path.join(__dirname, 'hooks', 'ganglion-hooks.json');
const settingsDir = path.join(os.homedir(), '.claude');
const settingsFile = path.join(settingsDir, 'settings.json');

const ganglionHooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;

// The hook commands ship with a GANGLION_SIGNAL placeholder because the absolute path to
// this checkout is only known at install time.
const signalScript = path.join(__dirname, 'hooks', 'ganglion-signal.js');
const signalCommand = `node "${signalScript}"`;

for (const entries of Object.values(ganglionHooks)) {
  for (const entry of entries) {
    for (const h of entry.hooks || []) {
      if (typeof h.command === 'string') {
        h.command = h.command.replace(/GANGLION_SIGNAL/g, signalCommand);
      }
    }
  }
}

fs.mkdirSync(settingsDir, { recursive: true });

let existing = {};
if (fs.existsSync(settingsFile)) {
  const backup = `${settingsFile}.backup-${Date.now()}`;
  fs.copyFileSync(settingsFile, backup);
  console.log(`Backed up existing settings to ${backup}`);
  try {
    existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (e) {
    console.error('Could not parse existing settings.json; aborting.');
    process.exit(1);
  }
}

existing.hooks = existing.hooks || {};

// Re-running replaces Ganglion's own entries and leaves every other hook alone (the
// agent-ops deploy-gate and PR-review hooks share this file). 'GANGLION_TAB_ID' also
// matches the old shell one-liner hooks from before ganglion-signal.js existed.
const GANGLION_MARKERS = ['GANGLION_TAB_ID', 'ganglion-signal'];
const isGanglionHook = (h) =>
  typeof h.command === 'string' && GANGLION_MARKERS.some((m) => h.command.includes(m));

for (const [event, entries] of Object.entries(ganglionHooks)) {
  existing.hooks[event] = existing.hooks[event] || [];
  existing.hooks[event] = existing.hooks[event].filter(
    (entry) => !(entry.hooks || []).some(isGanglionHook)
  );
  existing.hooks[event].push(...entries);
}

// Atomic: every Claude Code session reads this file, so it must never be seen half-written.
writeFileAtomic(settingsFile, JSON.stringify(existing, null, 2));
console.log(`Installed Ganglion hooks into ${settingsFile}`);
console.log('Hook events configured: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SessionEnd');
