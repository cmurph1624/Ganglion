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

test('resolveShell honours SHELL', () => {
  assert.strictEqual(resolveShell({ SHELL: '/bin/zsh' }), '/bin/zsh');
});

test('resolveShell falls back to /bin/bash without SHELL', () => {
  assert.strictEqual(resolveShell({}), '/bin/bash');
});

test('resolveShell defaults to the real env', () => {
  // Called with no arguments it must still produce something usable, since that is how
  // spawnPty will call it.
  const shell = resolveShell();
  assert.ok(typeof shell === 'string' && shell.length > 0);
});

// --- shellArgs ----------------------------------------------------------------------

test('shellArgs asks for a login shell', () => {
  assert.deepStrictEqual(shellArgs(), ['-l']);
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

test('cwdProbe returns an lsof invocation', () => {
  const probe = cwdProbe(4242);
  assert.strictEqual(probe.command, 'lsof');
  assert.deepStrictEqual(probe.args, ['-a', '-p', '4242', '-d', 'cwd', '-Fn']);
});

test('cwdProbe stringifies the pid', () => {
  // execFile rejects non-string args.
  assert.ok(cwdProbe(7).args.every((a) => typeof a === 'string'));
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
test('resolveClaudeBin defaults to the native installer location', () => {
  const expected = path.join(os.homedir(), '.local', 'bin', 'claude');
  assert.strictEqual(resolveClaudeBin({}), expected);
});

test('resolveClaudeBin honours GANGLION_CLAUDE_BIN', () => {
  // The systemd service's PATH may not include ~/.local/bin.
  assert.strictEqual(resolveClaudeBin({ GANGLION_CLAUDE_BIN: '/opt/claude' }), '/opt/claude');
});

test('the ingest drain pattern matches what signalFileFor produces', () => {
  // server.js drains leftover signals on boot by regex-matching filenames in signalDir().
  // That regex and this builder must not drift apart.
  const { INGEST_SIGNAL_PATTERN } = require('../lib/platform');
  assert.match(path.basename(signalFileFor('some-uuid-42', 'ingest')), INGEST_SIGNAL_PATTERN);
  assert.doesNotMatch(path.basename(signalFileFor('some-uuid-42', 'status')), INGEST_SIGNAL_PATTERN);
});
