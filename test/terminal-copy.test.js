'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { attachCopyOnSelection, refuseMouseReporting } = require('../renderer/terminal-copy');

// Why copy-on-selection exists at all:
//
// Claude Code turns on mouse tracking (?1000/?1002/?1003/?1006), so xterm forwards mouse
// events to the application and a plain drag selects nothing. Shift+drag is the override,
// and once the user has learned to hold Shift, making them then press Ctrl+C is a second
// piece of ceremony for no benefit -- and Ctrl+C is exactly the key that is ambiguous with
// SIGINT. Selecting *is* the copy, the way Windows Terminal and PuTTY have always behaved.
//
// The subscription is driven off xterm's own onSelectionChange rather than a DOM mouseup,
// deliberately: xterm finalises a drag selection in a document-level listener, so a handler
// on the terminal's host element would be racing it for the final coordinate. The event is
// also what makes this testable with no DOM at all.

/** A stand-in for navigator.clipboard. */
function fakeClipboard(behaviour = 'ok') {
  const calls = [];
  return {
    calls,
    writeText(text) {
      calls.push(text);
      return behaviour === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied'));
    }
  };
}

/**
 * A stand-in for a live xterm.
 *
 * `emit()` plays the role of the user dragging: xterm fires onSelectionChange repeatedly
 * during a drag, not once at the end.
 */
function fakeTerm(selection = '') {
  const listeners = [];
  const term = {
    current: selection,
    clearSelectionCalls: 0,
    onSelectionChange(cb) {
      listeners.push(cb);
      return { dispose() {} };
    },
    getSelection() {
      return term.current;
    },
    clearSelection() {
      term.clearSelectionCalls++;
    },
    emit(next) {
      if (next !== undefined) term.current = next;
      for (const cb of listeners) cb();
    }
  };
  return term;
}

/**
 * A controllable stand-in for setTimeout, so a debounce can be tested without waiting.
 *
 * Only the most recent pending callback is kept, which is all a debounce ever has.
 */
function fakeTimer() {
  let pending = null;
  let nextId = 1;
  return {
    setTimeout(fn) {
      pending = fn;
      return nextId++;
    },
    clearTimeout() {
      pending = null;
    },
    /** Let the debounce expire. */
    flush() {
      const fn = pending;
      pending = null;
      if (fn) fn();
    },
    get isPending() {
      return pending !== null;
    }
  };
}

/** Let every pending promise in the clipboard write chain resolve. */
const settle = () => new Promise((r) => setImmediate(r));

function deps(clipboard, extra = {}) {
  const timer = extra.timer || fakeTimer();
  return {
    timer,
    made: {
      clipboard: { writeClipboard: require('../renderer/clipboard').writeClipboard, makeExecCommandFallback: () => () => false },
      navigatorClipboard: clipboard,
      doc: null,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      onFailure: extra.onFailure || (() => {}),
      ...extra.overrides
    }
  };
}

test('selecting text copies it without any key press', async () => {
  const clipboard = fakeClipboard();
  const term = fakeTerm();
  const d = deps(clipboard);

  attachCopyOnSelection(term, d.made);
  term.emit('npm run desktop');
  d.timer.flush();
  await settle();

  assert.deepStrictEqual(clipboard.calls, ['npm run desktop']);
});

test('a drag produces exactly one clipboard write, not one per mouse move', async () => {
  // onSelectionChange fires on every mousemove. Writing the clipboard 40 times for one
  // gesture would be wasteful and would leave partial selections on it in between.
  const clipboard = fakeClipboard();
  const term = fakeTerm();
  const d = deps(clipboard);

  attachCopyOnSelection(term, d.made);
  term.emit('npm');
  term.emit('npm run');
  term.emit('npm run desktop');
  d.timer.flush();
  await settle();

  assert.deepStrictEqual(clipboard.calls, ['npm run desktop']);
});

test('clearing a selection leaves the clipboard alone', async () => {
  // A plain click deselects and fires the event with nothing selected. Copying that would
  // wipe whatever the user had on the clipboard -- the exact opposite of what they wanted.
  const clipboard = fakeClipboard();
  const term = fakeTerm();
  const d = deps(clipboard);

  attachCopyOnSelection(term, d.made);
  term.emit('');
  d.timer.flush();
  await settle();

  assert.deepStrictEqual(clipboard.calls, []);
});

test('a whitespace-only selection is not copied', async () => {
  // A stray drag across blank terminal. Same rule the Ctrl+C policy uses, so the two
  // bindings cannot disagree about what counts as a selection.
  const clipboard = fakeClipboard();
  const term = fakeTerm();
  const d = deps(clipboard);

  attachCopyOnSelection(term, d.made);
  term.emit('   \n  ');
  d.timer.flush();
  await settle();

  assert.deepStrictEqual(clipboard.calls, []);
});

test('re-firing with an unchanged selection does not rewrite the clipboard', async () => {
  // xterm re-fires the event for changes that do not alter the text (a refresh, a resize).
  // Rewriting would be harmless but would stomp on anything copied elsewhere in between.
  const clipboard = fakeClipboard();
  const term = fakeTerm();
  const d = deps(clipboard);

  attachCopyOnSelection(term, d.made);
  term.emit('same text');
  d.timer.flush();
  await settle();

  term.emit('same text');
  d.timer.flush();
  await settle();

  assert.deepStrictEqual(clipboard.calls, ['same text']);
});

test('the terminal selection stays highlighted after being copied', async () => {
  // Ctrl+C clears the selection on purpose, so the next Ctrl+C is an interrupt again. This
  // path must not: the highlight is the only feedback that the copy happened.
  const clipboard = fakeClipboard();
  const term = fakeTerm();
  const d = deps(clipboard);

  attachCopyOnSelection(term, d.made);
  term.emit('kept');
  d.timer.flush();
  await settle();

  assert.strictEqual(term.clearSelectionCalls, 0);
});

test('a failed copy is reported rather than silently swallowed', async () => {
  const failures = [];
  const term = fakeTerm();
  const d = deps(fakeClipboard('reject'), { onFailure: (m) => failures.push(m) });

  attachCopyOnSelection(term, d.made);
  term.emit('unreachable');
  d.timer.flush();
  await settle();

  assert.strictEqual(failures.length, 1);
});

test('a selection that failed to copy is retried on the next event', async () => {
  // Failure must not be recorded as "already copied", or a transient permission error would
  // wedge that selection out of the clipboard until the user reselected it.
  const clipboard = fakeClipboard('reject');
  const term = fakeTerm();
  const d = deps(clipboard);

  attachCopyOnSelection(term, d.made);
  term.emit('retry me');
  d.timer.flush();
  await settle();

  term.emit('retry me');
  d.timer.flush();
  await settle();

  assert.deepStrictEqual(clipboard.calls, ['retry me', 'retry me']);
});

test('attaching to a terminal with no onSelectionChange is a no-op, not a crash', async () => {
  // Both terminals in a split are wired by the same call site; a partially-constructed one
  // must not take the whole renderer down with it.
  assert.doesNotThrow(() => attachCopyOnSelection({}, deps(fakeClipboard()).made));
});

// --- refusing the mouse ------------------------------------------------------------------
//
// Claude Code asks for the mouse with CSI ? 1000/1002/1003 h. Any terminal that grants the
// request stops selecting on drag for as long as the app runs -- that is the protocol
// working, not a bug, and Shift+drag is the conventional escape hatch. Ganglion declines the
// request instead, because a terminal you cannot select out of is a worse trade than a TUI
// that cannot see the mouse. Swallowing the *enable* sequence is enough: xterm never turns
// tracking on, so nothing is ever forwarded regardless of which encoding was negotiated.

/** A stand-in for xterm's parser registration. */
function fakeParserTerm() {
  const handlers = [];
  return {
    handlers,
    parser: {
      registerCsiHandler(id, cb) {
        handlers.push({ id, cb });
        return { dispose() {} };
      }
    },
    /** Play a CSI sequence at whichever handler claims to match. */
    send(final, params, prefix = '?') {
      const h = handlers.find((x) => x.id.final === final && x.id.prefix === prefix);
      return h ? h.cb(params) : false;
    }
  };
}

test('the mouse-tracking enable sequences are swallowed', () => {
  const term = fakeParserTerm();
  refuseMouseReporting(term);

  // 1000 click, 1001 highlight, 1002 button-event/drag, 1003 any-event. Returning true is
  // xterm's protocol for "consumed -- do not process this".
  for (const mode of [1000, 1001, 1002, 1003]) {
    assert.strictEqual(term.send('h', [mode]), true, `mode ${mode} should be refused`);
  }
});

test('every other private mode is left alone', () => {
  // Swallowing indiscriminately would be catastrophic rather than merely wrong: 1049 is the
  // alternate screen buffer, 25 the cursor, 2004 bracketed paste -- which is what makes a
  // pasted newline not execute.
  const term = fakeParserTerm();
  refuseMouseReporting(term);

  for (const mode of [1, 7, 25, 1004, 1049, 2004]) {
    assert.strictEqual(term.send('h', [mode]), false, `mode ${mode} should pass through`);
  }
});

test('a sequence setting only mouse modes together is swallowed', () => {
  const term = fakeParserTerm();
  refuseMouseReporting(term);
  assert.strictEqual(term.send('h', [1002, 1003]), true);
});

test('a sequence mixing a mouse mode with a real one is passed through intact', () => {
  // CSI ? 1049 ; 1002 h sets the alternate screen *and* mouse tracking. A handler can only
  // consume the whole sequence or none of it, so consuming here would cost the alt-screen
  // switch and leave the display corrupt. Letting it through is the safe direction: the
  // worst case is the mouse working, which is merely the old behaviour.
  const term = fakeParserTerm();
  refuseMouseReporting(term);
  assert.strictEqual(term.send('h', [1049, 1002]), false);
});

test('sub-parameters do not throw', () => {
  // xterm hands back number[] for a param written as 1002:3.
  const term = fakeParserTerm();
  refuseMouseReporting(term);
  assert.strictEqual(term.send('h', [[1002, 3]]), true);
  assert.strictEqual(term.send('h', [[1049, 3]]), false);
});

test('an empty parameter list is not treated as a mouse request', () => {
  // CSI ? h with no params is malformed; claiming it would swallow it silently.
  const term = fakeParserTerm();
  refuseMouseReporting(term);
  assert.strictEqual(term.send('h', []), false);
});

test('only the enable sequence is intercepted, never the disable', () => {
  // Registering for `l` too would be redundant and would hide a real disable from xterm.
  const term = fakeParserTerm();
  refuseMouseReporting(term);
  assert.ok(term.handlers.every((x) => x.id.final === 'h'));
});

test('refusing the mouse on a terminal with no parser is a no-op, not a crash', () => {
  assert.doesNotThrow(() => refuseMouseReporting({}));
  assert.doesNotThrow(() => refuseMouseReporting(null));
  assert.strictEqual(refuseMouseReporting({}), undefined);
});
