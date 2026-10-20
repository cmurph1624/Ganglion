'use strict';

// Bindings to this machine (Linux): which shell to spawn, where the Claude Code hooks and
// this server agree to leave their signal files, how to read a pty's cwd, and which
// `claude` binary the distiller runs.

const os = require('node:os');
const path = require('node:path');

const SIGNAL_KINDS = ['status', 'tool', 'ingest'];

// Used by the boot-time drain in server.js to find signals left behind while it was down.
// Kept next to signalFileFor() so the writer and the matcher cannot drift apart.
const INGEST_SIGNAL_PATTERN = /^ganglion-.+-ingest$/;

/**
 * The shell to hand to pty.spawn(). Under systemd SHELL is usually unset, hence the
 * fallback (ganglion.env sets it explicitly anyway).
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
function resolveShell(env = process.env) {
  return env.SHELL || '/bin/bash';
}

/**
 * Arguments for the spawned shell: `-l` for a login shell, so tabs get the same profile
 * (PATH, nvm, ...) as an SSH login.
 *
 * @returns {string[]}
 */
function shellArgs() {
  return ['-l'];
}

/**
 * The directory both halves of the signal handshake must agree on.
 *
 * The Claude Code hooks WRITE these files; this server READS and WATCHES them. If the two
 * sides disagree about the directory, Ganglion still boots and tabs still work, but status
 * dots never update and no session is ever ingested -- with no error anywhere. Both sides
 * resolve it through here, and os.tmpdir() honours TMPDIR, which is how a second (test)
 * instance keeps off the live server's files.
 *
 * @returns {string}
 */
function signalDir() {
  return os.tmpdir();
}

/**
 * Absolute path of one signal file.
 *
 * @param {string} tabId
 * @param {'status'|'tool'|'ingest'} kind
 * @returns {string}
 */
function signalFileFor(tabId, kind) {
  if (!SIGNAL_KINDS.includes(kind)) {
    // A typo would produce a file nothing watches -- precisely the silent failure this
    // module exists to prevent -- so fail loudly rather than return a plausible path.
    throw new Error(`unknown signal kind: ${kind} (expected one of ${SIGNAL_KINDS.join(', ')})`);
  }
  return path.join(signalDir(), `ganglion-${tabId}-${kind}`);
}

/**
 * How to ask the OS for a pty's current working directory: `lsof -d cwd`.
 *
 * @param {number} pid
 * @returns {{command: string, args: string[]}}
 */
function cwdProbe(pid) {
  return { command: 'lsof', args: ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'] };
}

/**
 * Pull the path out of `lsof -Fn` output, which prefixes each field with its type letter.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
function parseCwdProbe(stdout) {
  const line = String(stdout || '')
    .split('\n')
    .find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/**
 * The `claude` executable the distiller shells out to. Defaults to where Claude Code's
 * native installer puts it (~/.local/bin/claude). GANGLION_CLAUDE_BIN overrides it, which
 * the systemd unit's env file sets, because the service's PATH may not include
 * ~/.local/bin -- and a missing binary only shows up as notes silently never appearing.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
function resolveClaudeBin(env = process.env) {
  if (env.GANGLION_CLAUDE_BIN) return env.GANGLION_CLAUDE_BIN;
  return path.join(os.homedir(), '.local', 'bin', 'claude');
}

module.exports = {
  resolveShell,
  shellArgs,
  signalDir,
  signalFileFor,
  cwdProbe,
  parseCwdProbe,
  resolveClaudeBin,
  SIGNAL_KINDS,
  INGEST_SIGNAL_PATTERN
};
