'use strict';

// Putting text on the clipboard from a front-end that is not always a secure context.
//
// `navigator.clipboard` is gated behind a secure context. Ganglion binds 0.0.0.0 -- that is
// what lets the Mac attach -- and the Mac reaches it as http://<lan-ip>:3000, which is not
// secure. So the modern API is present in Electron and in the local browser (localhost is
// treated as trustworthy) and absent from the browser front-end that most needs it. A
// clipboard write built on it alone works everywhere it is tested and silently does nothing
// where it is used.
//
// document.execCommand('copy') is deprecated but has no secure-context requirement, so it
// covers exactly the gap. Both paths are injected rather than reached for directly, which
// keeps this testable with no DOM (see test/clipboard.test.js) and keeps the decision about
// which one applies out of the caller.
//
// Lives in renderer/ for the same reason terminal-keys.js does: express.static already
// serves this directory, so a change here deploys by reload rather than by pm2 restart.

(() => {
  /**
   * @param {string} text
   * @param {{clipboard?: {writeText?: (t: string) => Promise<void>}, fallback?: (t: string) => boolean}} [deps]
   * @returns {Promise<boolean>} whether the text actually reached the clipboard
   */
  async function writeClipboard(text, deps = {}) {
    const str = text == null ? '' : String(text);
    // Not "nothing selected, so copy nothing" -- writing an empty string would wipe whatever
    // the user already had on the clipboard.
    if (str === '') return false;

    const clipboard = deps.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(str);
        return true;
      } catch {
        // Present but refused: permissions policy, or the document not being focused. Fall
        // through rather than give up.
        //
        // Known limitation, verified rather than assumed: execCommand('copy') needs
        // transient user activation, and awaiting the rejection above has already consumed
        // it. So this particular fallback -- modern API present *and* failing -- will
        // usually fail too, and the caller is told so. The path that matters, the Mac
        // front-end where navigator.clipboard is simply absent, never awaits anything and
        // so keeps its activation; that one is exercised end to end.
      }
    }

    if (typeof deps.fallback === 'function') {
      try {
        return deps.fallback(str) === true;
      } catch {
        // execCommand throws outright in some embedded contexts. This runs inside a keydown
        // handler, so it must not propagate.
      }
    }

    return false;
  }

  /**
   * The execCommand path, which needs a real DOM selection to operate on.
   *
   * xterm keeps its selection in its own model, so there is nothing natively selected to
   * copy; this borrows the page for one tick with an off-screen textarea holding the text.
   *
   * @param {Document} doc
   * @returns {(text: string) => boolean}
   */
  function makeExecCommandFallback(doc) {
    return (text) => {
      const ta = doc.createElement('textarea');
      ta.value = text;
      // Off-screen rather than display:none or hidden: an unrendered element cannot hold a
      // selection, and execCommand('copy') copies the selection.
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);

      const restore = doc.activeElement;
      try {
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        return doc.execCommand('copy') === true;
      } finally {
        ta.remove();
        // Focus was stolen from the terminal to make the selection; give it straight back,
        // or the next keystroke goes nowhere.
        if (restore && typeof restore.focus === 'function') restore.focus();
      }
    };
  }

  const api = { writeClipboard, makeExecCommandFallback };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ganglionClipboard = api;
})();
