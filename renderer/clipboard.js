'use strict';

// Terminal -> local clipboard.
//
// Text leaves a terminal for the clipboard two ways, and Ganglion used to handle neither
// well:
//
//   - The user copies a selection. Cmd+C on a Mac already worked (xterm answers the
//     browser's native copy event). Ctrl+Shift+C did not: it is not a copy shortcut in any
//     browser -- in Chrome it opens the DevTools element picker -- so it has to be done
//     here, by hand.
//   - A program asks for it with OSC 52 (ESC ] 52 ; c ; <base64> BEL). This is how Claude
//     Code, tmux and vim reach the clipboard of the machine you are sitting at. Claude Code
//     tries pbcopy / wl-copy / xsel first, but on a headless server none exist, so OSC 52
//     is the only way its copy gets out -- and xterm.js ignores OSC 52 unless someone
//     registers a handler. Until this file, every copy in a Ganglion tab went nowhere.
//
// Writing the clipboard is gated by the browser. navigator.clipboard needs a secure context
// (HTTPS or localhost -- Ganglion over plain http://<tailnet-ip>:3000 is neither), and
// Safari additionally wants a user gesture, which an OSC 52 arriving over the WebSocket
// never has. So every write degrades in order: clipboard API -> execCommand('copy') ->
// a toast whose click is the gesture that finishes the copy.
//
// parseOsc52() is pure and DOM-free so test/clipboard.test.js can pin it under node:test,
// the same way terminal-keys.js is tested.

(() => {
  // 1 MiB of decoded text. Anything bigger is almost certainly a program dumping binary at
  // the terminal, not a copy anyone asked for.
  const MAX_OSC52_BYTES = 1024 * 1024;
  const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

  /**
   * Decode the payload of an OSC 52 sequence (everything after "52;").
   *
   * Only writes are honoured. A "?" payload is a request to READ the clipboard back into
   * the terminal -- answering it would hand the clipboard to anything that can print to
   * the pty (a `cat` of a hostile file is enough), so it is always refused. An empty
   * payload (clear the clipboard) is ignored rather than acted on.
   *
   * @param {string} data  e.g. "c;aGVsbG8="
   * @returns {string|null} the text to copy, or null to ignore the sequence
   */
  function parseOsc52(data) {
    if (typeof data !== 'string') return null;
    const sep = data.indexOf(';');
    if (sep < 0) return null;
    const payload = data.slice(sep + 1);
    if (payload === '' || payload === '?') return null;
    if (payload.length > Math.ceil(MAX_OSC52_BYTES / 3) * 4) return null;
    if (!BASE64.test(payload)) return null;

    let binary;
    try { binary = atob(payload); } catch { return null; }
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }

  // --- DOM side: never runs under node:test ------------------------------------------------

  // Works without a secure context, but only inside a user gesture (a keydown or a click).
  function execCommandCopy(text) {
    const previous = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    // The hidden textarea took focus from xterm's own; hand it back so typing continues.
    if (previous && typeof previous.focus === 'function') previous.focus();
    return ok;
  }

  async function writeClipboard(text) {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    return execCommandCopy(text);
  }

  let toastEl = null;
  let toastTimer = null;

  function showToast(message, { onClick = null, ms = 1500 } = {}) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'clipboard-toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.toggle('actionable', !!onClick);
    toastEl.onclick = onClick;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; toastEl.onclick = null; }, ms);
  }

  function describe(text) {
    const lines = text.split('\n').length;
    return lines > 1 ? `${lines} lines` : `${text.length} chars`;
  }

  /**
   * Put text on the local clipboard, telling the user what happened. If the browser
   * refuses, leave a toast that finishes the copy on click (the click is the gesture).
   */
  async function copyText(text) {
    if (!text) return;
    if (await writeClipboard(text)) {
      showToast(`Copied ${describe(text)}`);
      return;
    }
    showToast(`Click to copy ${describe(text)} from the terminal`, {
      ms: 15000,
      onClick: () => {
        const ok = execCommandCopy(text);
        showToast(ok ? `Copied ${describe(text)}` : 'Copy failed: the browser blocked it');
      }
    });
  }

  /**
   * Wire OSC 52 into a terminal. Returns the function the tab should feed pty output
   * through instead of calling term.write() directly.
   *
   * The wrapper exists for replay: on reconnect the server resends up to 512 KB of old
   * output, and any OSC 52 in it would otherwise overwrite today's clipboard with
   * whatever was copied before the reload. Replayed chunks are counted in and out via
   * write()'s completion callback -- xterm parses writes in order, so a live chunk queued
   * behind a replay is not seen until the replay has finished.
   *
   * @param {import('@xterm/xterm').Terminal} term
   * @returns {((data: string, meta?: {replay?: boolean}) => void) & {isReplaying: () => boolean}}
   */
  function attachOsc52(term) {
    let replaying = 0;

    term.parser.registerOscHandler(52, (data) => {
      // Every attached front-end receives the same pty output, so a copy made from the Mac
      // also reaches an iPad left open on the same tab. Only the window in use acts on it.
      if (replaying > 0 || !document.hasFocus()) return true;
      const text = parseOsc52(data);
      if (text) copyText(text);
      return true;
    });

    const write = (data, meta) => {
      if (!meta?.replay) { term.write(data); return; }
      replaying++;
      term.write(data, () => { replaying--; });
    };
    // Old output can hold terminal queries (e.g. DA1 `ESC[c`) that xterm answers through
    // onData. The caller drops input while this is true, so those answers don't get typed
    // into the shell -- after a restart, that's a fresh prompt.
    write.isReplaying = () => replaying > 0;
    return write;
  }

  const api = { parseOsc52, copyText, attachOsc52, MAX_OSC52_BYTES };

  // Loaded two ways: as a classic <script> by renderer/index.html, and by require() from
  // test/clipboard.test.js.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.ganglionClipboard = api;
})();
