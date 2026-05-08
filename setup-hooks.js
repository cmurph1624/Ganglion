#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const hooksFile = path.join(__dirname, 'hooks', 'ganglion-hooks.json');
const settingsDir = path.join(os.homedir(), '.claude');
const settingsFile = path.join(settingsDir, 'settings.json');

const ganglionHooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;

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

const GANGLION_MARKER = 'GANGLION_TAB_ID';

for (const [event, entries] of Object.entries(ganglionHooks)) {
  existing.hooks[event] = existing.hooks[event] || [];
  existing.hooks[event] = existing.hooks[event].filter((entry) => {
    return !(entry.hooks || []).some(
      (h) => typeof h.command === 'string' && h.command.includes(GANGLION_MARKER)
    );
  });
  existing.hooks[event].push(...entries);
}

fs.writeFileSync(settingsFile, JSON.stringify(existing, null, 2));
console.log(`Installed Ganglion hooks into ${settingsFile}`);
console.log('Hook events configured: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SessionEnd');
