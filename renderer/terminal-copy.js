'use strict';

// The glue between the key policy (terminal-keys.js), the clipboard writer (clipboard.js)
// and a live xterm instance.
//
// It lives in its own file rather than inside renderer.js so that the code that actually
// ships can be loaded and driven on its own -- the pure decision is unit-tested, but the
// part that reads xterm's selection and hands it to the clipboard only means anything in a
// browser, and inlining it in renderer.js would make it reachable exclusively by booting
// the whole app against a WebSocket.
//
// Dependencies are injected with live defaults for the same reason.

(() => {
  /**
   * Install Ganglion's key policy on one xterm instance.
   *
   * Both terminals in a tab (left, and the optional right split) get this. It used to be
   * copy-pasted into each call site, which is how Ctrl+K came to be wrong in two places at
   * once.
   *
   * @param {{attachCustomKeyEventHandler: Function, getSelection: () => string, clearSelection: () => void}} term
   * @param {{keys?: object, clipboard?: object, navigatorClipboard?: object, doc?: Document, onFailure?: (m: string) => void}} [deps]
   */
  function attachKeyPolicy(term, deps = {}) {
    const keys = deps.keys || window.ganglionTerminalKeys;
    const clip = deps.clipboard || window.ganglionClipboard;
    const doc = deps.doc || document;
    const navClipboard = 'navigatorClipboard' in deps ? deps.navigatorClipboard : navigator.clipboard;
    const onFailure = deps.onFailure || ((m) => console.warn(m));

    term.attachCustomKeyEventHandler((e) => {
      // Whether anything is selected is the one thing the policy cannot see for itself, and
      // it decides whether Ctrl+C copies or interrupts. Trimmed deliberately: a stray
      // click-drag across blank terminal leaves a whitespace-only selection, and letting
      // that count would disarm the interrupt key at exactly the wrong moment. When the
      // selection is ambiguous SIGINT wins -- Ctrl+Shift+C is there to force a copy.
      const selection = term.getSelection() || '';
      const decision = keys.classifyTerminalKey(e, { hasSelection: selection.trim() !== '' });

      if (decision.preventDefault) e.preventDefault();
      if (decision.copySelection) {
        clip.writeClipboard(selection, {
          clipboard: navClipboard,
          fallback: clip.makeExecCommandFallback(doc)
        }).then((ok) => {
          if (!ok) {
            // The key was already withheld from the pty, so a silent failure would leave
            // the user believing they have the text.
            onFailure('Ganglion: copy failed; selection left in place');
            return;
          }
          // Clear on success so the NEXT Ctrl+C is an interrupt again. Without this, a
          // selection made an hour ago quietly disarms the interrupt key for the session.
          term.clearSelection();
        });
      }
      return decision.toTerminal;
    });
  }

  const api = { attachKeyPolicy };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ganglionTerminalCopy = api;
})();
