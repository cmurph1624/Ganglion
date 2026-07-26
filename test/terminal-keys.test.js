'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyTerminalKey, isMemoryShortcut } = require('../renderer/terminal-keys');

// Ctrl+K used to fire twice: xterm's custom key handler returned true (so ^K reached the
// pty and readline killed to end of line) AND the memory panel's document-level keydown
// toggled the overlay. Neither handler knew about the other, and preventDefault() could
// not help -- xterm had already acted by then, and preventDefault does not stop
// propagation.
//
// The fix is to make the two agree, which means the decision has to live somewhere both
// can read it. This module is that place, and these tests pin the contract: the terminal
// declines exactly the keys the app claims, and nothing else changes.
//
// It sits in renderer/ rather than lib/ for one practical reason: express.static already
// serves renderer/, so the browser gets it with no new server route -- and therefore no
// pm2 restart to deploy a key-handling change.

/** Build a KeyboardEvent-shaped plain object. Only the fields the policy reads. */
function ev(overrides = {}) {
  return {
    type: 'keydown',
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
  };
}

// --- isMemoryShortcut(): what the overlay claims ---------------------------------------

test('Ctrl+K is the memory shortcut', () => {
  assert.strictEqual(isMemoryShortcut(ev({ key: 'k', ctrlKey: true })), true);
});

test('Cmd+K is the memory shortcut too (the Mac browser)', () => {
  // The overlay is documented as Ctrl/Cmd+K and one of the two front-ends is a browser on
  // a Mac, so meta has to count.
  assert.strictEqual(isMemoryShortcut(ev({ key: 'k', metaKey: true })), true);
});

test('the shortcut is case-insensitive', () => {
  // Caps lock, or Ctrl+Shift+K, both report key: 'K'.
  assert.strictEqual(isMemoryShortcut(ev({ key: 'K', ctrlKey: true })), true);
});

test('an unmodified k is not the shortcut', () => {
  // Otherwise typing "k" in a shell would open the overlay.
  assert.strictEqual(isMemoryShortcut(ev({ key: 'k' })), false);
});

test('other modified letters are not the shortcut', () => {
  for (const key of ['j', 'l', 'c', 'v']) {
    assert.strictEqual(isMemoryShortcut(ev({ key, ctrlKey: true })), false, key);
  }
});

test('a missing or non-string key is not the shortcut', () => {
  // Some synthetic events (and older IME paths) omit `key`; reading .toLowerCase() off
  // undefined would throw inside a document-level keydown handler and break every
  // subsequent listener on the page.
  assert.strictEqual(isMemoryShortcut(ev({ key: undefined, ctrlKey: true })), false);
  assert.strictEqual(isMemoryShortcut({ ctrlKey: true }), false);
});

// --- classifyTerminalKey(): the bug this module exists to fix ---------------------------

test('Ctrl+K is declined by the terminal, so ^K never reaches the pty', () => {
  // The regression test for the double-fire. `toTerminal: false` is what stops xterm
  // writing the control character; the overlay then handles the same event on its way up
  // to document.
  const result = classifyTerminalKey(ev({ key: 'k', ctrlKey: true }));
  assert.strictEqual(result.toTerminal, false);
});

test('the terminal does not preventDefault the memory shortcut', () => {
  // Deliberately left to the overlay's own handler. Suppressing the browser default here
  // would work, but it would put the decision in two places again -- which is the shape of
  // bug this module exists to remove.
  const result = classifyTerminalKey(ev({ key: 'k', ctrlKey: true }));
  assert.strictEqual(result.preventDefault, false);
});

test('Cmd+K is declined by the terminal as well', () => {
  const result = classifyTerminalKey(ev({ key: 'k', metaKey: true }));
  assert.strictEqual(result.toTerminal, false);
});

test('every key the overlay claims is declined by the terminal', () => {
  // The invariant, stated directly: the two handlers can never both act on one event.
  // If someone adds a second app shortcut to isMemoryShortcut and forgets the terminal
  // side, this fails rather than shipping another double-fire.
  for (const e of [
    ev({ key: 'k', ctrlKey: true }),
    ev({ key: 'K', ctrlKey: true }),
    ev({ key: 'k', metaKey: true }),
    ev({ key: 'K', ctrlKey: true, shiftKey: true })
  ]) {
    assert.strictEqual(isMemoryShortcut(e), true);
    assert.strictEqual(classifyTerminalKey(e).toTerminal, false);
  }
});

// --- deliberate browser passthroughs (must not regress) ---------------------------------

test('Ctrl+V is left to the browser so paste works', () => {
  const result = classifyTerminalKey(ev({ key: 'v', ctrlKey: true }));
  assert.strictEqual(result.toTerminal, false);
  assert.strictEqual(result.preventDefault, false);
});

test('Ctrl+Shift+V is left to the browser too', () => {
  // Shift makes the reported key uppercase; both cases have always been passed through.
  const result = classifyTerminalKey(ev({ key: 'V', ctrlKey: true, shiftKey: true }));
  assert.strictEqual(result.toTerminal, false);
});

// --- copy: Ctrl+C means two different things -------------------------------------------
// Handing clipboard keys to "the browser" was wrong twice over. xterm keeps its selection
// in its own model rather than as a DOM selection, so there is frequently no native
// selection for the browser to copy; and Ctrl+C was additionally preventDefault()ed by the
// generic control-key branch below, so no copy event ever fired anyway. The result was a
// Ctrl+C that could only ever send SIGINT. Every terminal emulator resolves this the same
// way: with a selection it copies, without one it interrupts.

test('Ctrl+C with a selection copies instead of interrupting', () => {
  const result = classifyTerminalKey(ev({ key: 'c', ctrlKey: true }), { hasSelection: true });
  assert.strictEqual(result.copySelection, true);
  assert.strictEqual(result.toTerminal, false, 'SIGINT must not also be sent');
});

test('Ctrl+C with a selection suppresses the browser default', () => {
  // Otherwise the browser copy path can also fire and we race our own write.
  const result = classifyTerminalKey(ev({ key: 'c', ctrlKey: true }), { hasSelection: true });
  assert.strictEqual(result.preventDefault, true);
});

test('Ctrl+C without a selection is still SIGINT', () => {
  // The behaviour that must not regress: interrupting a running Claude is what this key is
  // for, and it has to keep working without looking at the clipboard first.
  const result = classifyTerminalKey(ev({ key: 'c', ctrlKey: true }), { hasSelection: false });
  assert.strictEqual(result.toTerminal, true);
  assert.strictEqual(result.copySelection, false);
});

test('Ctrl+C defaults to SIGINT when no selection state is supplied', () => {
  // A caller that forgets the second argument must fail towards the safe answer: sending an
  // interrupt that was not wanted is recoverable, swallowing one is not.
  assert.strictEqual(classifyTerminalKey(ev({ key: 'c', ctrlKey: true })).toTerminal, true);
  assert.strictEqual(classifyTerminalKey(ev({ key: 'c', ctrlKey: true })).copySelection, false);
});

test('Ctrl+Shift+C copies whether or not the terminal has a selection', () => {
  // The explicit copy binding. With nothing selected it simply copies nothing, which is
  // better than falling through to SIGINT on a key the user pressed meaning "copy".
  for (const hasSelection of [true, false]) {
    const result = classifyTerminalKey(ev({ key: 'C', ctrlKey: true, shiftKey: true }), { hasSelection });
    assert.strictEqual(result.copySelection, true, String(hasSelection));
    assert.strictEqual(result.toTerminal, false, String(hasSelection));
  }
});

test('Ctrl+Shift+C suppresses the browser default', () => {
  // In Chrome this chord opens the DevTools element picker, which is emphatically not what
  // someone pressing the terminal copy binding wants.
  const result = classifyTerminalKey(ev({ key: 'C', ctrlKey: true, shiftKey: true }), { hasSelection: true });
  assert.strictEqual(result.preventDefault, true);
});

test('copySelection is false for every key that is not a copy binding', () => {
  // Pins the blast radius: a selection sitting in the terminal must not change what any
  // other key does. Ctrl+A in particular is readline's start-of-line, not select-all.
  for (const key of ['a', 'e', 'u', 'w', 'v', 'd', 'l', 'r']) {
    const result = classifyTerminalKey(ev({ key, ctrlKey: true }), { hasSelection: true });
    assert.strictEqual(result.copySelection, false, key);
  }
  assert.strictEqual(classifyTerminalKey(ev({ key: 'c' }), { hasSelection: true }).copySelection, false);
});

// --- ordinary control keys reach the shell, not the browser -----------------------------

test('Ctrl+W reaches the shell and is kept from the browser', () => {
  // preventDefault is the point of the whole Ctrl branch: Ctrl+W would otherwise close the
  // browser tab, taking every terminal in the window with it.
  const result = classifyTerminalKey(ev({ key: 'w', ctrlKey: true }));
  assert.strictEqual(result.toTerminal, true);
  assert.strictEqual(result.preventDefault, true);
});

test('Ctrl+T, Ctrl+L and Ctrl+R reach the shell', () => {
  // New tab / focus location bar / reload -- all things a terminal user means for readline.
  for (const key of ['t', 'l', 'r']) {
    const result = classifyTerminalKey(ev({ key, ctrlKey: true }));
    assert.strictEqual(result.toTerminal, true, key);
    assert.strictEqual(result.preventDefault, true, key);
  }
});

test('Ctrl+A, Ctrl+E and Ctrl+U still reach readline', () => {
  // The neighbours of the key that broke. If the fix had been written as "swallow control
  // keys", these would be the collateral damage.
  for (const key of ['a', 'e', 'u']) {
    assert.strictEqual(classifyTerminalKey(ev({ key, ctrlKey: true })).toTerminal, true, key);
  }
});

test('unmodified keys are passed straight through untouched', () => {
  for (const key of ['a', 'Enter', 'ArrowUp', 'Tab', 'Escape']) {
    const result = classifyTerminalKey(ev({ key }));
    assert.strictEqual(result.toTerminal, true, key);
    assert.strictEqual(result.preventDefault, false, key);
  }
});

test('Cmd combinations other than the shortcut are left alone entirely', () => {
  // Mac copy/paste. Calling preventDefault on these would break the Mac browser front-end,
  // which is why the Ctrl branch checks !metaKey rather than matching either modifier.
  for (const key of ['c', 'v', 'a']) {
    const result = classifyTerminalKey(ev({ key, metaKey: true }));
    assert.strictEqual(result.preventDefault, false, key);
  }
});

test('Alt combinations are untouched (meta-prefixed readline bindings)', () => {
  // Alt+B / Alt+F are word-motion in readline; xterm turns them into ESC-prefixed input.
  for (const key of ['b', 'f']) {
    const result = classifyTerminalKey(ev({ key, altKey: true }));
    assert.strictEqual(result.toTerminal, true, key);
    assert.strictEqual(result.preventDefault, false, key);
  }
});

// --- non-keydown events -----------------------------------------------------------------

test('keyup and keypress are handed back to xterm unchanged', () => {
  // xterm needs its own keyup handling (modifier tracking); the policy only decides
  // keydown. Declining a keyup would leave xterm believing Ctrl is still held.
  for (const type of ['keyup', 'keypress']) {
    const result = classifyTerminalKey(ev({ type, key: 'k', ctrlKey: true }));
    assert.strictEqual(result.toTerminal, true, type);
    assert.strictEqual(result.preventDefault, false, type);
  }
});
