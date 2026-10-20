'use strict';

// Scrollback search for one terminal: a small bar over the top-right of its pane, driven by
// xterm's search addon. Opened from the key policy (Ctrl+Shift+F / Cmd+F, see
// terminal-keys.js). Enter = next, Shift+Enter = previous, Esc closes and gives focus
// back to the terminal.

(() => {
  // Match highlights need literal #RRGGBB colours; take them from the palette in styles.css.
  function decorations() {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const match = v('--mark-ink', '#6E4F12');
    const active = v('--term-cursor', '#E2B862');
    return {
      matchBackground: match,
      matchOverviewRuler: match,
      activeMatchBackground: active,
      activeMatchColorOverviewRuler: active
    };
  }

  /**
   * @param {import('@xterm/xterm').Terminal} term
   * @param {HTMLElement} paneEl the terminal's positioned container
   * @returns {{open: () => void, close: () => void}}
   */
  function attachSearch(term, paneEl) {
    const addon = new window.SearchAddon.SearchAddon();
    term.loadAddon(addon);

    const bar = document.createElement('div');
    bar.className = 'term-search';
    bar.hidden = true;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search scrollback';
    input.spellcheck = false;

    const count = document.createElement('span');
    count.className = 'term-search-count';

    const button = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };

    const find = (forward, incremental = false) => {
      const q = input.value;
      if (!q) {
        addon.clearDecorations();
        count.textContent = '';
        return;
      }
      const opts = { incremental, decorations: decorations() };
      const found = forward ? addon.findNext(q, opts) : addon.findPrevious(q, opts);
      if (!found) count.textContent = 'No matches';
    };

    addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!input.value) count.textContent = '';
      else if (resultCount === 0) count.textContent = 'No matches';
      else count.textContent = resultIndex >= 0 ? `${resultIndex + 1}/${resultCount}` : `${resultCount}`;
    });

    function open() {
      bar.hidden = false;
      input.focus();
      input.select();
      if (input.value) find(true, true);
    }

    function close() {
      bar.hidden = true;
      addon.clearDecorations();
      term.clearSelection();
      count.textContent = '';
      term.focus();
    }

    input.addEventListener('input', () => find(true, true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        find(!e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (window.ganglionTerminalKeys.isSearchShortcut(e)) {
        // Pressing the shortcut again keeps the bar and stops the browser's find.
        e.preventDefault();
        input.select();
      }
    });

    bar.append(
      input,
      count,
      button('↑', 'Previous match (Shift+Enter)', () => find(false)),
      button('↓', 'Next match (Enter)', () => find(true)),
      button('×', 'Close (Esc)', close)
    );
    paneEl.appendChild(bar);

    return { open, close };
  }

  window.ganglionTerminalSearch = { attachSearch };
})();
