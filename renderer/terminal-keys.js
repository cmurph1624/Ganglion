'use strict';

// Who gets a key press: the pty, the browser, or the app?
//
// Three parties want the same keydown, and until this module existed they answered
// independently:
//
//   - xterm, via attachCustomKeyEventHandler -- returning true means xterm processes the
//     key normally, which for a control combination means writing the control character
//     to the pty.
//   - the browser, whose own Ctrl+W / Ctrl+T / Ctrl+L defaults would close the tab or
//     steal focus out from under a terminal that meant them for readline.
//   - the app, i.e. the Ctrl/Cmd+K memory overlay, on a document-level listener.
//
// Ctrl+K hit all three at once: xterm returned true (so readline killed to end of line)
// AND the overlay opened. preventDefault could not fix it -- by the time the document
// listener ran, xterm had already written to the pty, and preventDefault does not stop
// propagation. The only fix is for the terminal to decline the key up front, which means
// both handlers have to be reading the same rule.
//
// So the rule lives here, once, and both callers import it. Pure and DOM-free: it reads
// five fields off an event-shaped object and returns a decision, which is what makes it
// testable under node:test with no jsdom (see test/terminal-keys.test.js).
//
// Lives in renderer/ rather than lib/ deliberately: express.static already serves this
// directory, so the browser picks it up with no new server route -- and therefore key
// handling stays deployable by reload rather than by pm2 restart.

(() => {
  /**
   * Is this the global memory-overlay shortcut?
   *
   * Single source of truth for the binding documented as "Ctrl/Cmd+K". Meta counts because
   * one of the two front-ends is a browser on a Mac. Shift is not checked, so Ctrl+Shift+K
   * also opens the overlay -- deliberate, and the terminal side agrees because it asks
   * this same function.
   *
   * @param {{key?: unknown, ctrlKey?: boolean, metaKey?: boolean}} e
   * @returns {boolean}
   */
  function isMemoryShortcut(e) {
    if (!e || (!e.ctrlKey && !e.metaKey)) return false;
    // Guarded because this runs inside a document-level keydown handler: a synthetic event
    // without `key` would throw here and kill every listener registered after it.
    if (typeof e.key !== 'string') return false;
    return e.key.toLowerCase() === 'k';
  }

  /**
   * Decide what happens to a key event that landed on a terminal.
   *
   * @param {{type?: string, key?: unknown, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean}} e
   * @returns {{toTerminal: boolean, preventDefault: boolean}}
   *   `toTerminal` is the value to return from attachCustomKeyEventHandler: true lets
   *   xterm process the key (and so reach the pty), false makes xterm ignore it and leaves
   *   the event to whoever else is listening.
   */
  function classifyTerminalKey(e) {
    // Only keydown is ours. xterm tracks modifier state on keyup, so declining one would
    // leave it believing Ctrl is still held.
    if (!e || e.type !== 'keydown') return { toTerminal: true, preventDefault: false };

    // App shortcuts outrank both the pty and the browser. No preventDefault: the overlay's
    // own handler does that when it acts, so the suppression stays next to the behaviour
    // instead of being split across two files again.
    if (isMemoryShortcut(e)) return { toTerminal: false, preventDefault: false };

    // `!metaKey` matters: on a Mac, Cmd+C / Cmd+V arrive with metaKey set, and swallowing
    // those would break copy and paste in the browser front-end.
    if (e.ctrlKey && !e.metaKey) {
      // Clipboard bindings belong to the browser. Ctrl+C without shift is left alone
      // below, because in a terminal that is SIGINT.
      const key = typeof e.key === 'string' ? e.key : '';
      if (key === 'v' || key === 'V' || (e.shiftKey && key === 'C')) {
        return { toTerminal: false, preventDefault: false };
      }
      // Everything else the user typed with Ctrl was meant for the shell. preventDefault
      // stops the browser acting on Ctrl+W/T/L/R as well, which is the main reason the
      // desktop shell exists -- but the browser front-end wants it too.
      return { toTerminal: true, preventDefault: true };
    }

    return { toTerminal: true, preventDefault: false };
  }

  const api = { classifyTerminalKey, isMemoryShortcut };

  // Loaded two ways: as a classic <script> by renderer/index.html, and by require() from
  // test/terminal-keys.test.js.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ganglionTerminalKeys = api;
})();
