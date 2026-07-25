'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { signalWrites } = require('../lib/hook-signal');
const { signalDir, signalFileFor } = require('../lib/platform');

const TAB = { GANGLION_TAB_ID: 'tab-1' };

function fileOf(writes, kind) {
  const want = signalFileFor('tab-1', kind);
  return writes.find((w) => w.file === want);
}

// --- the no-op guard ----------------------------------------------------------------
// Running `claude` outside Ganglion must be completely inert.

test('no writes when GANGLION_TAB_ID is unset', () => {
  assert.deepStrictEqual(signalWrites('SessionStart', {}, {}), []);
  assert.deepStrictEqual(signalWrites('Stop', { session_id: 's' }, {}), []);
});

test('no writes for an unrecognised event', () => {
  assert.deepStrictEqual(signalWrites('SomethingElse', {}, TAB), []);
});

// --- status transitions -------------------------------------------------------------

test('SessionStart marks the tab idle', () => {
  assert.strictEqual(fileOf(signalWrites('SessionStart', {}, TAB), 'status').contents, 'idle');
});

test('UserPromptSubmit marks the tab working', () => {
  assert.strictEqual(fileOf(signalWrites('UserPromptSubmit', {}, TAB), 'status').contents, 'working');
});

test('Notification marks the tab waiting', () => {
  assert.strictEqual(fileOf(signalWrites('Notification', {}, TAB), 'status').contents, 'waiting');
});

// --- tool tracking ------------------------------------------------------------------

test('PreToolUse records the tool name and marks the tab working', () => {
  const w = signalWrites('PreToolUse', { tool_name: 'Bash' }, TAB);
  assert.strictEqual(fileOf(w, 'tool').contents, 'Bash');
  assert.strictEqual(fileOf(w, 'status').contents, 'working');
});

test('PreToolUse tolerates a payload with no tool_name', () => {
  assert.strictEqual(fileOf(signalWrites('PreToolUse', {}, TAB), 'tool').contents, '');
});

test('PostToolUse clears the tool without touching status', () => {
  const w = signalWrites('PostToolUse', {}, TAB);
  assert.strictEqual(fileOf(w, 'tool').contents, '');
  assert.strictEqual(fileOf(w, 'status'), undefined);
});

// --- ingest -------------------------------------------------------------------------

test('Stop writes an ingest signal carrying the transcript path', () => {
  const w = signalWrites(
    'Stop',
    { session_id: 'abc', transcript_path: '/x/y.jsonl', cwd: '/x', hook_event_name: 'Stop' },
    TAB
  );
  const payload = JSON.parse(fileOf(w, 'ingest').contents);
  assert.deepStrictEqual(payload, {
    session_id: 'abc',
    transcript_path: '/x/y.jsonl',
    cwd: '/x',
    event: 'Stop'
  });
});

test('SessionEnd also ingests, and labels the event correctly', () => {
  const w = signalWrites('SessionEnd', { session_id: 'abc', hook_event_name: 'SessionEnd' }, TAB);
  assert.strictEqual(JSON.parse(fileOf(w, 'ingest').contents).event, 'SessionEnd');
});

test('the event label falls back to the hook name when absent from the payload', () => {
  const w = signalWrites('Stop', { session_id: 'abc' }, TAB);
  assert.strictEqual(JSON.parse(fileOf(w, 'ingest').contents).event, 'Stop');
});

test('Stop and SessionEnd both reset status and tool', () => {
  for (const ev of ['Stop', 'SessionEnd']) {
    const w = signalWrites(ev, { session_id: 'a' }, TAB);
    assert.strictEqual(fileOf(w, 'status').contents, 'idle');
    assert.strictEqual(fileOf(w, 'tool').contents, '');
  }
});

// --- the recursion guard ------------------------------------------------------------
// The distiller shells out to `claude -p`. If that subprocess emitted an ingest signal it
// would ingest itself, and distilling that would emit another. The original hook guarded
// this with `[ -z "$GANGLION_DISTILL" ]`; the behaviour must survive the port.

test('no ingest signal is emitted under GANGLION_DISTILL', () => {
  const env = { ...TAB, GANGLION_DISTILL: '1' };
  for (const ev of ['Stop', 'SessionEnd']) {
    const w = signalWrites(ev, { session_id: 'a', transcript_path: '/x.jsonl' }, env);
    assert.strictEqual(fileOf(w, 'ingest'), undefined, `${ev} must not ingest while distilling`);
  }
});

test('status and tool are still reset under GANGLION_DISTILL', () => {
  // Only ingest is suppressed -- the dot must not get stuck on "working".
  const w = signalWrites('Stop', {}, { ...TAB, GANGLION_DISTILL: '1' });
  assert.strictEqual(fileOf(w, 'status').contents, 'idle');
});

// --- the handshake property ---------------------------------------------------------

test('every write lands in signalDir()', () => {
  // This is the whole point of routing hooks through lib/platform: the writer and the
  // reader derive their paths from one function, so they cannot disagree.
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
  for (const ev of events) {
    for (const w of signalWrites(ev, { session_id: 'a', tool_name: 'Read' }, TAB)) {
      assert.strictEqual(path.dirname(w.file), signalDir(), `${ev} wrote outside signalDir()`);
    }
  }
});

test('no write path contains a hardcoded /tmp on win32', () => {
  if (process.platform !== 'win32') return;
  const events = ['SessionStart', 'PreToolUse', 'Stop'];
  for (const ev of events) {
    for (const w of signalWrites(ev, { session_id: 'a' }, TAB)) {
      assert.ok(!w.file.startsWith('/tmp'), `${ev} still targets /tmp`);
    }
  }
});
