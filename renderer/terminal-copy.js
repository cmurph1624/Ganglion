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
  // How long a selection must stop changing before it is copied. xterm fires
  // onSelectionChange on every mousemove of a drag, so without this a single gesture would
  // write the clipboard dozens of times and leave partial selections on it in between.
  // Short enough to feel instant; well inside the 5s transient-activation window that the
  // execCommand fallback needs, so the Mac front-end can still use this path.
  const SETTLE_MS = 80;

  // The DECSET modes that turn mouse reporting on: 1000 click, 1001 highlight, 1002
  // button-event (drag), 1003 any-event. Deliberately not the encoding modes (1005/1006/
  // 1015/1016) -- those only say how an event would be spelled, and with tracking never
  // enabled none is ever sent, so intercepting them would be noise.
  const MOUSE_TRACKING_MODES = new Set([1000, 1001, 1002, 1003]);

  /**
   * Decline the application's request for the mouse.
   *
   * Claude Code sends `CSI ? 1000/1002/1003 h`, and a terminal that grants that stops
   * selecting on drag for as long as the app runs. That is the protocol behaving correctly
   * -- Shift+drag is the conventional escape hatch -- but it is a bad trade here: Ganglion's
   * whole purpose is watching Claude work, and text you cannot drag out of a terminal is a
   * daily tax to buy a TUI feature that costs little to lose.
   *
   * So the enable sequence is swallowed and tracking is simply never turned on. What this
   * costs, honestly: clicks inside Claude's own UI no longer register, and the wheel drives
   * xterm's scrollback rather than Claude's view.
   *
   * Only the `h` (enable) form is intercepted. Letting `l` through keeps xterm's own notion
   * of the mode consistent, and disabling something never enabled is free.
   *
   * @param {{parser?: {registerCsiHandler?: Function}}} term
   * @returns {{dispose: Function}|undefined} the parser disposable, when there was one.
   */
  function refuseMouseReporting(term) {
    if (!term || !term.parser || typeof term.parser.registerCsiHandler !== 'function') return undefined;

    return term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      // A malformed `CSI ? h` claims nothing; swallowing it would hide it from xterm.
      if (!params || params.length === 0) return false;

      for (const param of params) {
        // A param written as `1002:3` arrives as an array of sub-parameters.
        const mode = Array.isArray(param) ? param[0] : param;
        // One sequence can set several modes at once, and a handler consumes all of it or
        // none of it. `CSI ? 1049 ; 1002 h` is the alternate screen *plus* tracking --
        // swallowing that would cost the screen switch and leave the display corrupt. Erring
        // toward passing it on is safe: the worst case is the mouse working as it used to.
        if (!MOUSE_TRACKING_MODES.has(mode)) return false;
      }

      // true means "consumed". Claude asked; the answer is no.
      return true;
    });
  }

  /**
   * Resolve the clipboard dependencies once, and return something that just writes text.
   *
   * Shared by both bindings so they cannot drift into disagreeing about which clipboard
   * path applies -- the reason the fallback exists at all is that the answer differs per
   * front-end (see clipboard.js).
   *
   * @param {object} deps
   * @returns {(text: string) => Promise<boolean>}
   */
  function makeWriter(deps) {
    const clip = deps.clipboard || window.ganglionClipboard;
    // `in` rather than `||`: the tests inject a null document deliberately, and falling
    // back to the global there would reference a `document` that does not exist in node.
    const doc = 'doc' in deps ? deps.doc : document;
    const navClipboard = 'navigatorClipboard' in deps ? deps.navigatorClipboard : navigator.clipboard;
    return (text) => clip.writeClipboard(text, {
      clipboard: navClipboard,
      fallback: clip.makeExecCommandFallback(doc)
    });
  }

  /**
   * Copy the terminal's selection as soon as it is made, with no key press.
   *
   * Ganglion needs this more than a normal terminal does. A tab running Claude Code has
   * mouse tracking on, so the user must already hold Shift to select anything at all;
   * requiring Ctrl+C on top of that is ceremony, and Ctrl+C is precisely the key that is
   * ambiguous with SIGINT. Making the selection itself the copy -- the Windows Terminal and
   * PuTTY behaviour -- removes both problems at once.
   *
   * Driven off xterm's own event rather than a DOM mouseup: xterm finalises a drag in a
   * document-level listener, so a handler on the host element would be racing it for the
   * last coordinate.
   *
   * The selection is deliberately left highlighted, which is the only feedback that
   * anything happened. Ctrl+C keeps its existing behaviour untouched.
   *
   * @param {{onSelectionChange?: Function, getSelection?: () => string}} term
   * @param {object} [deps]
   * @returns {{dispose: Function}|undefined} xterm's disposable, when there was one to take.
   */
  function attachCopyOnSelection(term, deps = {}) {
    // A terminal still being constructed must not take the renderer down with it: both
    // terminals of a split are wired from the same call site.
    if (!term || typeof term.onSelectionChange !== 'function') return undefined;

    const write = makeWriter(deps);
    const onFailure = deps.onFailure || ((m) => console.warn(m));
    const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimeout || ((id) => clearTimeout(id));
    const settleMs = typeof deps.settleMs === 'number' ? deps.settleMs : SETTLE_MS;

    let pending = null;
    let lastCopied = null;

    return term.onSelectionChange(() => {
      if (pending !== null) clearTimer(pending);
      pending = setTimer(() => {
        pending = null;
        const selection = term.getSelection() || '';
        // Same rule as the Ctrl+C policy, so the two bindings cannot disagree about what
        // counts as a selection. A click that deselects arrives here as an empty string,
        // and copying that would wipe whatever the user already had.
        if (selection.trim() === '') return;
        // xterm re-fires for changes that do not alter the text. Rewriting would stomp on
        // anything copied elsewhere in the meantime.
        if (selection === lastCopied) return;

        // Recorded before the write resolves so an event burst cannot queue the same text
        // twice, and released again on failure so the next event retries -- a transient
        // permission error must not wedge that selection out of the clipboard until the
        // user reselects it.
        lastCopied = selection;
        write(selection).then((ok) => {
          if (ok) return;
          lastCopied = null;
          onFailure('Ganglion: copy-on-select failed; the selection is still there, try Ctrl+Shift+C');
        });
      }, settleMs);
    });
  }

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
    const write = makeWriter(deps);
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
        write(selection).then((ok) => {
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

  const api = { attachKeyPolicy, attachCopyOnSelection, refuseMouseReporting };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ganglionTerminalCopy = api;
})();
