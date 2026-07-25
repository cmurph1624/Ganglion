'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const {
  resolveShell,
  shellArgs,
  signalDir,
  signalFileFor,
  cwdProbe,
  parseCwdProbe,
  resolveClaudeBin
} = require('../lib/platform');

// --- resolveShell -------------------------------------------------------------------
// server.js spawns the pty with `process.env.SHELL || '/bin/bash'`, which yields a path
// that does not exist on Windows.

test('resolveShell returns powershell.exe on win32', () => {
  assert.strictEqual(resolveShell('win32', {}), 'powershell.exe');
});

test('resolveShell ignores SHELL on win32', () => {
  // Git for Windows, MSYS and WSL interop all leak a POSIX-looking SHELL into the
  // environment. Honouring it here would spawn a shell that cannot start.
  assert.strictEqual(resolveShell('win32', { SHELL: '/bin/zsh' }), 'powershell.exe');
});

test('resolveShell honours SHELL on posix', () => {
  assert.strictEqual(resolveShell('linux', { SHELL: '/bin/zsh' }), '/bin/zsh');
  assert.strictEqual(resolveShell('darwin', { SHELL: '/usr/local/bin/fish' }), '/usr/local/bin/fish');
});

test('resolveShell falls back to /bin/bash on posix without SHELL', () => {
  assert.strictEqual(resolveShell('linux', {}), '/bin/bash');
});

test('resolveShell defaults to the running platform and real env', () => {
  // Called with no arguments it must still produce something usable, since that is how
  // spawnPty will call it.
  const shell = resolveShell();
  assert.ok(typeof shell === 'string' && shell.length > 0);
  if (process.platform === 'win32') assert.match(shell, /powershell\.exe$|pwsh\.exe$/);
});

// --- shellArgs ----------------------------------------------------------------------
// `-l` requests a login shell. Windows has no such concept and powershell.exe treats it
// as an ambiguous prefix of -LiteralPath, so it must not be passed.

test('shellArgs drops the login flag on win32', () => {
  assert.deepStrictEqual(shellArgs('win32'), []);
});

test('shellArgs keeps the login flag on posix', () => {
  assert.deepStrictEqual(shellArgs('linux'), ['-l']);
  assert.deepStrictEqual(shellArgs('darwin'), ['-l']);
});

// --- signalDir / signalFileFor ------------------------------------------------------
// These files are one half of a handshake: the Claude Code hooks WRITE them and
// server.js READS/WATCHES them. If the two halves disagree about the directory,
// Ganglion boots and tabs work, but status dots never update and no session is ever
// ingested -- silently, with no error. Defining the location once is what makes that
// drift impossible rather than merely unlikely.

test('signalDir resolves to the OS temp directory', () => {
  assert.strictEqual(signalDir(), os.tmpdir());
});

test('signalDir never returns the hardcoded /tmp on win32', () => {
  if (process.platform === 'win32') {
    assert.notStrictEqual(signalDir(), '/tmp');
  }
});

test('signalDir is absolute and stable across calls', () => {
  assert.ok(path.isAbsolute(signalDir()));
  assert.strictEqual(signalDir(), signalDir());
});

test('signalFileFor builds the documented ganglion-<tabId>-<kind> name', () => {
  const f = signalFileFor('abc123', 'status');
  assert.strictEqual(path.dirname(f), signalDir());
  assert.strictEqual(path.basename(f), 'ganglion-abc123-status');
});

test('signalFileFor supports all three signal kinds', () => {
  for (const kind of ['status', 'tool', 'ingest']) {
    assert.strictEqual(path.basename(signalFileFor('t1', kind)), `ganglion-t1-${kind}`);
  }
});

test('all three signal kinds share one directory', () => {
  // The property that actually prevents the silent-failure mode.
  const dirs = ['status', 'tool', 'ingest'].map((k) => path.dirname(signalFileFor('t1', k)));
  assert.strictEqual(new Set(dirs).size, 1);
});

test('signalFileFor rejects an unknown kind', () => {
  // A typo here would produce a file nothing watches, which is exactly the failure this
  // helper exists to prevent -- so fail loudly instead.
  assert.throws(() => signalFileFor('t1', 'stats'), /unknown signal kind/i);
});

// --- cwdProbe -----------------------------------------------------------------------
// server.js resolved a tab's working directory by shelling out to `lsof`, which does not
// exist on Windows. The old code called it unconditionally and let the spawn failure fall
// through to cwd:null -- so the feature broke while looking like a normal empty result.

test('cwdProbe returns an lsof invocation on posix', () => {
  const probe = cwdProbe(4242, 'linux');
  assert.strictEqual(probe.command, 'lsof');
  assert.deepStrictEqual(probe.args, ['-a', '-p', '4242', '-d', 'cwd', '-Fn']);
});

test('cwdProbe stringifies the pid', () => {
  // execFile rejects non-string args.
  assert.ok(cwdProbe(7, 'darwin').args.every((a) => typeof a === 'string'));
});

test('cwdProbe returns null on win32 rather than a doomed command', () => {
  // Windows exposes no supported way to read another process's cwd, so the caller must
  // short-circuit instead of spawning something guaranteed to fail on every request.
  assert.strictEqual(cwdProbe(4242, 'win32'), null);
});

test('parseCwdProbe extracts the n-prefixed path from lsof -Fn output', () => {
  const stdout = 'p4242\nfcwd\nn/home/claudedev/Documents/dev/Ganglion\n';
  assert.strictEqual(parseCwdProbe(stdout), '/home/claudedev/Documents/dev/Ganglion');
});

test('parseCwdProbe returns null when no path line is present', () => {
  assert.strictEqual(parseCwdProbe('p4242\nfcwd\n'), null);
  assert.strictEqual(parseCwdProbe(''), null);
});

// --- resolveClaudeBin ---------------------------------------------------------------
// distiller.js hardcoded ~/.npm-global/bin/claude, which is a Linux-only install layout.

test('resolveClaudeBin keeps the npm-global path on posix', () => {
  const expected = path.join(os.homedir(), '.npm-global', 'bin', 'claude');
  assert.strictEqual(resolveClaudeBin('linux', {}), expected);
});

test('resolveClaudeBin resolves from PATH on win32', () => {
  // Claude Code on Windows installs to %USERPROFILE%\.local\bin\claude.exe (native) or the
  // npm prefix (claude.cmd). Neither matches the Linux layout, so defer to PATH lookup.
  assert.strictEqual(resolveClaudeBin('win32', {}), 'claude');
});

test('resolveClaudeBin honours an explicit override on every platform', () => {
  // Needed because a pm2 Windows Service runs under an account whose PATH may not include
  // the interactive user's install location.
  const override = 'D:\\tools\\claude.exe';
  assert.strictEqual(resolveClaudeBin('win32', { GANGLION_CLAUDE_BIN: override }), override);
  assert.strictEqual(resolveClaudeBin('linux', { GANGLION_CLAUDE_BIN: '/opt/claude' }), '/opt/claude');
});

test('the ingest drain pattern matches what signalFileFor produces', () => {
  // server.js drains leftover signals on boot by regex-matching filenames in signalDir().
  // That regex and this builder must not drift apart.
  const { INGEST_SIGNAL_PATTERN } = require('../lib/platform');
  assert.match(path.basename(signalFileFor('some-uuid-42', 'ingest')), INGEST_SIGNAL_PATTERN);
  assert.doesNotMatch(path.basename(signalFileFor('some-uuid-42', 'status')), INGEST_SIGNAL_PATTERN);
});
