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
// server restart to deploy a key-handling change.

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

test('Ctrl+Shift+C copies the selection itself instead of leaving it to the browser', () => {
  // This used to be passed through "so copy works" -- but no browser binds Ctrl+Shift+C to
  // copy. Chrome opened the DevTools element picker.
  // The terminal has to do the copy, and the browser default has to be stopped.
  const result = classifyTerminalKey(ev({ key: 'C', ctrlKey: true, shiftKey: true }));
  assert.strictEqual(result.toTerminal, false);
  assert.strictEqual(result.preventDefault, true);
  assert.strictEqual(result.copySelection, true);
});

test('only Ctrl+Shift+C asks for a copy', () => {
  for (const e of [
    ev({ key: 'c', ctrlKey: true }),                  // SIGINT
    ev({ key: 'V', ctrlKey: true, shiftKey: true }),  // paste
    ev({ key: 'c', metaKey: true }),                  // Mac: native copy event does it
    ev({ key: 'C', shiftKey: true })                  // just a capital C
  ]) {
    assert.ok(!classifyTerminalKey(e).copySelection, JSON.stringify(e));
  }
});

test('Ctrl+C without shift is SIGINT, not copy', () => {
  // The whole reason copy is bound to Ctrl+Shift+C in a terminal.
  const result = classifyTerminalKey(ev({ key: 'c', ctrlKey: true }));
  assert.strictEqual(result.toTerminal, true);
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

// --- isSearchShortcut(): the scrollback search bar --------------------------------------

const { isSearchShortcut } = require('../renderer/terminal-keys');

test('Ctrl+Shift+F and Cmd+F open search', () => {
  for (const e of [ev({ key: 'F', ctrlKey: true, shiftKey: true }), ev({ key: 'f', metaKey: true })]) {
    assert.strictEqual(isSearchShortcut(e), true);
    assert.deepStrictEqual(classifyTerminalKey(e), { toTerminal: false, preventDefault: true, openSearch: true });
  }
});

test('plain Ctrl+F still reaches the shell (readline forward-char)', () => {
  const e = ev({ key: 'f', ctrlKey: true });
  assert.strictEqual(isSearchShortcut(e), false);
  assert.deepStrictEqual(classifyTerminalKey(e), { toTerminal: true, preventDefault: true });
});

test('search shortcut ignores keyup and other keys', () => {
  assert.strictEqual(isSearchShortcut(ev({ key: 'g', metaKey: true })), false);
  assert.strictEqual(isSearchShortcut({}), false);
  assert.deepStrictEqual(
    classifyTerminalKey(ev({ type: 'keyup', key: 'f', metaKey: true })),
    { toTerminal: true, preventDefault: false }
  );
});
