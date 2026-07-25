'use strict';

// Platform-dependent bindings, isolated so the Windows/POSIX branches are defined once.
//
// "The repo is portable; the bindings to this machine are not." Everything in here is a
// binding: which shell to spawn, and where the Claude Code hooks and this server agree to
// leave their signal files.

const os = require('node:os');
const path = require('node:path');

const SIGNAL_KINDS = ['status', 'tool', 'ingest'];

// Used by the boot-time drain in server.js to find signals left behind while it was down.
// Kept next to signalFileFor() so the writer and the matcher cannot drift apart.
const INGEST_SIGNAL_PATTERN = /^ganglion-.+-ingest$/;

/**
 * The shell to hand to pty.spawn().
 *
 * On Windows SHELL is deliberately ignored: Git for Windows, MSYS and WSL interop all leak
 * a POSIX-looking value (e.g. /bin/bash) into the environment, and spawning that would fail.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
function resolveShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') return 'powershell.exe';
  return env.SHELL || '/bin/bash';
}

/**
 * Arguments for the spawned shell.
 *
 * `-l` requests a login shell. Windows has no login-shell concept, and powershell.exe reads
 * `-l` as an ambiguous prefix of -LiteralPath, so it must not be passed.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
function shellArgs(platform = process.platform) {
  return platform === 'win32' ? [] : ['-l'];
}

/**
 * The directory both halves of the signal handshake must agree on.
 *
 * The Claude Code hooks WRITE these files; this server READS and WATCHES them. If the two
 * sides disagree about the directory, Ganglion still boots and tabs still work, but status
 * dots never update and no session is ever ingested -- with no error anywhere. The hook
 * side must therefore resolve to the same place ($env:TEMP in PowerShell,
 * tempfile.gettempdir() in Python), which is what os.tmpdir() reports here.
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
 * How to ask the OS for a pty's current working directory, or null if it cannot be asked.
 *
 * POSIX uses `lsof -d cwd`. Windows exposes no supported way to read another process's cwd
 * -- neither Win32_Process nor Get-Process carries it, and reading the PEB is not available
 * from Node -- so callers must short-circuit rather than spawn a command that fails on
 * every request. The user-visible cost is that tab cwd and repo-name display are inert on
 * Windows. Emitting OSC 7 from the shell prompt and parsing it out of the pty stream would
 * restore them, but that is a feature change rather than a port.
 *
 * @param {number} pid
 * @param {NodeJS.Platform} [platform]
 * @returns {{command: string, args: string[]}|null}
 */
function cwdProbe(pid, platform = process.platform) {
  if (platform === 'win32') return null;
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
 * The `claude` executable the distiller shells out to.
 *
 * POSIX keeps the existing ~/.npm-global/bin/claude path so the Linux box is unaffected.
 * Windows has no equivalent layout -- the native installer puts claude.exe under
 * %USERPROFILE%\.local\bin and the npm install produces claude.cmd -- so resolution is left
 * to PATH.
 *
 * GANGLION_CLAUDE_BIN overrides both. That matters once pm2 runs as a Windows Service:
 * the service account's PATH may not include the interactive user's install location, and
 * the failure would surface only as distillation silently never producing notes.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
function resolveClaudeBin(platform = process.platform, env = process.env) {
  if (env.GANGLION_CLAUDE_BIN) return env.GANGLION_CLAUDE_BIN;
  if (platform === 'win32') return 'claude';
  return path.join(os.homedir(), '.npm-global', 'bin', 'claude');
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
