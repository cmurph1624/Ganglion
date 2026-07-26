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
 * PowerShell that teaches the shell to announce its own working directory.
 *
 * Windows cannot be asked for another process's cwd (see cwdProbe below), so the shell has
 * to volunteer it. OSC 7 is the established convention for that: the prompt emits
 * `ESC ] 7 ; file://<host>/<path> BEL` and whoever owns the stream reads it back --
 * lib/osc7.js, in our case. This is strictly better than a probe would have been, because
 * it follows `cd` within the shell rather than reporting a process-level cwd.
 *
 * Three details are load-bearing:
 *
 * - It WRAPS the existing prompt rather than defining one. Whatever the user's profile
 *   installed (oh-my-posh, starship, hand-rolled) has already loaded by the time this runs,
 *   and replacing it would be a visible regression in every tab.
 * - The re-entry guard is not theoretical: run the init twice in one session without it and
 *   the wrapper captures itself, so the next prompt recurses until the shell dies.
 * - Each path segment is escaped separately. EscapeUriString would leave a literal `%` in a
 *   directory name unescaped, and decodeURIComponent on the far side throws on that.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string|null}
 */
function shellInitScript(platform = process.platform) {
  if (platform !== 'win32') return null;
  return [
    'if (-not $global:__ganglionInnerPrompt) {',
    '  $global:__ganglionInnerPrompt = $function:prompt',
    '  function global:prompt {',
    '    try {',
    // A non-filesystem location (cd HKLM:, cd Env:) has a ProviderPath that is not a usable
    // path; reporting it would rename the tab after a directory that does not exist.
    "      if ($PWD.Provider.Name -eq 'FileSystem') {",
    "        $__g = (($PWD.ProviderPath -replace '\\\\','/').Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'",
    '        [Console]::Write([char]27 + "]7;file://" + [Environment]::MachineName + "/" + $__g + [char]7)',
    '      }',
    // The prompt runs before every command. It must never be the thing that breaks a shell.
    '    } catch { }',
    '    & $global:__ganglionInnerPrompt',
    '  }',
    '}'
  ].join('\n');
}

/**
 * Arguments for the spawned shell.
 *
 * `-l` requests a login shell. Windows has no login-shell concept, and powershell.exe reads
 * `-l` as an ambiguous prefix of -LiteralPath, so it must not be passed.
 *
 * On Windows the args also carry the OSC 7 prompt wrapper above. It goes over
 * -EncodedCommand (base64 of UTF-16LE, which is what PowerShell requires) rather than
 * -Command because the script contains quotes, `$`, braces and backslashes, and would
 * otherwise have to survive node-pty's command-line joining, cmd's parser and PowerShell's
 * parser intact. -NoExit keeps the session interactive once the init has run; -NoProfile is
 * deliberately absent so the user's profile still loads -- and loads FIRST, which is what
 * lets the wrapper capture the profile's own prompt.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
function shellArgs(platform = process.platform) {
  if (platform !== 'win32') return ['-l'];
  const encoded = Buffer.from(shellInitScript('win32'), 'utf16le').toString('base64');
  return ['-NoExit', '-EncodedCommand', encoded];
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
 * every request.
 *
 * Returning null here is no longer the end of the story: the Windows answer comes from the
 * other direction, with the shell announcing its directory via OSC 7 (see shellInitScript
 * above) and server.js reading it out of the pty stream through lib/osc7.js. Callers should
 * prefer that tracked value and treat this probe as the fallback.
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

/**
 * Build the shell command Claude Code runs for a hook event.
 *
 * Claude Code executes hook commands through a SHELL, and on Windows that shell is the
 * bundled Git bash -- not PowerShell, not cmd. Git bash does NOT carry the Windows PATH
 * entry for `C:\Program Files\nodejs`, so a bare `node` fails there with
 * "node: command not found".
 *
 * That failure is silent by design: hook errors are non-blocking, so Claude Code logs the
 * error to its own transcript and carries on. The observable result is that no status dot
 * ever moves and no session is ever ingested, with nothing wrong in Ganglion's own logs.
 * Sharing signalFileFor() between the hook writer and server.js made the two halves agree
 * about WHERE to write; this makes the writer actually run.
 *
 * process.execPath is used as the default because it is an absolute path to a node that
 * demonstrably works -- it is the one executing setup-hooks.js.
 *
 * Forward slashes throughout: Node accepts them on Windows, and backslashes would need
 * double-escaping through JSON and would read as escape sequences in bash.
 *
 * @param {string} signalScript Absolute path to hooks/ganglion-signal.js
 * @param {string} [nodeBin] Absolute path to the node binary
 * @returns {string}
 */
function hookCommand(signalScript, nodeBin = process.execPath) {
  const fwd = (p) => String(p).replace(/\\/g, '/');
  return `"${fwd(nodeBin)}" "${fwd(signalScript)}"`;
}

module.exports = {
  resolveShell,
  shellArgs,
  shellInitScript,
  signalDir,
  signalFileFor,
  cwdProbe,
  parseCwdProbe,
  resolveClaudeBin,
  hookCommand,
  SIGNAL_KINDS,
  INGEST_SIGNAL_PATTERN
};
