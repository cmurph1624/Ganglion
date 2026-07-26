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
  resolveClaudeBin,
  hookCommand,
  shellInitScript
} = require('../lib/platform');
const { createCwdTracker } = require('../lib/osc7');

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

test('shellArgs never passes the login flag on win32', () => {
  assert.ok(!shellArgs('win32').includes('-l'));
});

test('shellArgs keeps the login flag on posix', () => {
  assert.deepStrictEqual(shellArgs('linux'), ['-l']);
  assert.deepStrictEqual(shellArgs('darwin'), ['-l']);
});

// --- shellInitScript / the win32 cwd channel ----------------------------------------
// Windows has no readable per-process cwd, so cwdProbe() returns null and tab names would
// be frozen forever. Instead the shell volunteers its directory: these args install a
// prompt wrapper that emits OSC 7, which lib/osc7.js reads back out of the pty stream.

test('shellInitScript is win32-only', () => {
  // POSIX already answers via `lsof -d cwd`, so there is no reason to touch the user's
  // shell there -- and bash would need a different mechanism (PROMPT_COMMAND) anyway.
  assert.strictEqual(shellInitScript('linux'), null);
  assert.strictEqual(shellInitScript('darwin'), null);
  assert.ok(shellInitScript('win32').length > 0);
});

test('shellInitScript wraps the existing prompt instead of replacing it', () => {
  // The profile's prompt (oh-my-posh, starship, a hand-rolled one) must survive. The
  // wrapper captures whatever `prompt` is at install time and calls through to it.
  const script = shellInitScript('win32');
  assert.match(script, /\$function:prompt/);
  assert.match(script, /&\s*\$global:__ganglionInnerPrompt/);
});

test('shellInitScript refuses to wrap itself twice', () => {
  // Without the guard, running the init a second time in one session captures our own
  // wrapper as the "inner" prompt and the next prompt recurses until the shell dies.
  assert.match(shellInitScript('win32'), /if\s*\(-not\s+\$global:__ganglionInnerPrompt\)/);
});

test('shellInitScript only reports real filesystem directories', () => {
  // `cd HKLM:` or `cd Env:` leaves a ProviderPath that is not a path any consumer of
  // pty:cwd could use -- fs.existsSync would fail and the tab would be renamed to junk.
  assert.match(shellInitScript('win32'), /Provider\.Name\s+-eq\s+'FileSystem'/);
});

test('shellArgs hands the init script to powershell without quoting it', () => {
  // The script contains quotes, $, {} and backslashes. Interpolating it into a command
  // line would mean escaping it correctly through node-pty AND cmd AND PowerShell's own
  // parser; -EncodedCommand sidesteps all three. -NoExit keeps the shell interactive
  // afterwards, and the profile still loads because -NoProfile is absent.
  const args = shellArgs('win32');
  assert.ok(args.includes('-NoExit'), 'shell must stay interactive');
  assert.ok(!args.includes('-NoProfile'), 'the user profile must still load');

  const i = args.indexOf('-EncodedCommand');
  assert.ok(i !== -1, 'init must be passed base64-encoded');

  // PowerShell requires base64 of UTF-16LE, and decoding it back must yield the script
  // verbatim -- a mismatch here fails at runtime as a syntax error inside the pty.
  const decoded = Buffer.from(args[i + 1], 'base64').toString('utf16le');
  assert.strictEqual(decoded, shellInitScript('win32'));
});

test('the emitted prompt sequence is one lib/osc7.js can read back', () => {
  // The two halves of this handshake live in different languages and only meet at
  // runtime inside a pty. Pinning the wire format on both sides is what keeps a change to
  // one from silently freezing tab names again.
  const emitted = '\x1b]7;file://STIGMERGYLABS/C%3A/Users/rdpuser/Documents/Dev/Ganglion\x07';
  assert.strictEqual(
    createCwdTracker().push(emitted),
    path.win32.join('C:', 'Users', 'rdpuser', 'Documents', 'Dev', 'Ganglion')
  );

  const script = shellInitScript('win32');
  assert.match(script, /\[char\]27/);          // ESC
  assert.match(script, /\]7;file:\/\//);       // OSC 7, file URI
  assert.match(script, /\[char\]7/);           // BEL terminator
  assert.match(script, /EscapeDataString/);    // percent-encoding, per segment
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

// --- hookCommand --------------------------------------------------------------------
// Claude Code executes hook commands through a SHELL, and on Windows that shell is the
// bundled Git bash -- not PowerShell and not cmd. Git bash does not inherit the Windows
// PATH entry for `C:\Program Files\nodejs`, so a bare `node` fails there with
// "node: command not found". Because hook failures are non-blocking, every event then
// dies silently: no status dot ever moves and no session is ever ingested, with the only
// trace being a line in Claude Code's own transcript. This is exactly the failure the
// signalFileFor() sharing was meant to make impossible, arriving one layer higher up.

test('hookCommand interpolates an absolute node binary, never a bare `node`', () => {
  const cmd = hookCommand('C:/repo/hooks/ganglion-signal.js', 'C:/Program Files/nodejs/node.exe');
  assert.doesNotMatch(cmd, /^node\s/, 'must not rely on `node` being on PATH');
  assert.match(cmd, /node\.exe/);
});

test('hookCommand quotes both paths so spaces survive the shell', () => {
  // The default install path contains a space ("Program Files"); unquoted it splits into
  // two argv entries and the hook fails in a way that looks like a missing file.
  const cmd = hookCommand('C:/My Repos/Ganglion/hooks/ganglion-signal.js', 'C:/Program Files/nodejs/node.exe');
  assert.match(cmd, /"C:\/Program Files\/nodejs\/node\.exe"/);
  assert.match(cmd, /"C:\/My Repos\/Ganglion\/hooks\/ganglion-signal\.js"/);
});

test('hookCommand normalises backslashes to forward slashes', () => {
  // Backslashes would need double-escaping through JSON and would be read as escape
  // sequences by bash. Node accepts forward slashes on Windows.
  const cmd = hookCommand(String.raw`C:\repo\hooks\ganglion-signal.js`, String.raw`C:\Program Files\nodejs\node.exe`);
  assert.doesNotMatch(cmd, /\\/);
});

test('hookCommand defaults its interpreter to the running node', () => {
  // process.execPath is always an absolute path to a node that demonstrably works, since
  // it is the one executing setup-hooks.js.
  const cmd = hookCommand('/repo/hooks/ganglion-signal.js');
  assert.ok(cmd.includes(process.execPath.split('\\').join('/')));
});
