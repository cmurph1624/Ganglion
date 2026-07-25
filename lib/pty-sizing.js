'use strict';

// How big is a pty when more than one client is looking at it?
//
// Ganglion mirrors: every connected client sees the same tabs and the same output
// (server.js broadcasts pty:data to all of them). But `pty:resize` used to retarget the
// one shared pty on every message, so a browser on the Mac and a desktop window on this
// box would fight -- each fit() overwriting the other's dimensions, continuously, with
// visible corruption.
//
// tmux settled this: the pty is sized to the MINIMUM over attached clients, so the grid
// fits inside every viewport. The client with the smallest window is authoritative; the
// larger one sees unused space rather than wrapped garbage.
//
// This module is deliberately pure -- no sockets, no pty handles. server.js supplies the
// WebSocket as an opaque client key and applies whatever size comes back.

/**
 * Is this a dimension a pty can actually be set to?
 *
 * Zero can wedge a pty, and NaN poisons every subsequent Math.min it touches, so bad
 * input is refused at the door rather than stored and minimised later.
 *
 * @param {unknown} n
 * @returns {boolean}
 */
function isValidDimension(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

/**
 * Track each client's desired size per tab and report the size the pty should take.
 *
 * @returns {{
 *   set: (clientKey: unknown, tabId: string, cols: number, rows: number) => boolean,
 *   effective: (tabId: string) => {cols: number, rows: number} | null,
 *   removeClient: (clientKey: unknown) => string[],
 *   removeTab: (tabId: string) => void
 * }}
 */
function createSizeRegistry() {
  // tabId -> Map<clientKey, {cols, rows}>. The inner Map is keyed by identity, which is
  // what lets server.js use the `ws` object directly instead of allocating client ids.
  const byTab = new Map();

  /**
   * Record one client's desired size for one tab.
   *
   * Returns false and changes nothing if the dimensions are unusable -- a malformed
   * message must leave the pty at the last good size, not clear the client's entry.
   */
  function set(clientKey, tabId, cols, rows) {
    if (!isValidDimension(cols) || !isValidDimension(rows)) return false;
    let clients = byTab.get(tabId);
    if (!clients) {
      clients = new Map();
      byTab.set(tabId, clients);
    }
    clients.set(clientKey, { cols, rows });
    return true;
  }

  /**
   * The size the pty should be, or null if no client has reported one.
   *
   * null rather than a default: inventing 80x24 here would resize a pty nobody has
   * measured. Clients that have not reported for THIS tab are ignored rather than counted
   * as zero -- renderer/styles.css hides inactive panes with `display: none`, so xterm's
   * fitAddon cannot measure them and a second window legitimately has no opinion about a
   * tab it has never opened.
   */
  function effective(tabId) {
    const clients = byTab.get(tabId);
    if (!clients || clients.size === 0) return null;

    let cols = Infinity;
    let rows = Infinity;
    for (const size of clients.values()) {
      if (size.cols < cols) cols = size.cols;
      if (size.rows < rows) rows = size.rows;
    }
    // Every stored dimension is already >= 1, so this floor is belt-and-braces against a
    // future caller that bypasses set().
    return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
  }

  /**
   * Forget a departed client entirely.
   *
   * Returns the tab ids it had reported sizes for, so the caller can re-apply just those
   * ptys -- this is what gives the remaining window its space back when the smaller one
   * closes. Tabs the client never measured are not returned; resizing those would move
   * ptys the departure cannot possibly have affected.
   */
  function removeClient(clientKey) {
    const affected = [];
    for (const [tabId, clients] of byTab) {
      if (!clients.delete(clientKey)) continue;
      affected.push(tabId);
      if (clients.size === 0) byTab.delete(tabId);
    }
    return affected;
  }

  /**
   * Forget a tab entirely.
   *
   * Called when a pty exits or is killed: without it, a respawned tab id would inherit
   * the dimensions clients measured against the previous, now-dead pty.
   */
  function removeTab(tabId) {
    byTab.delete(tabId);
  }

  return { set, effective, removeClient, removeTab };
}

module.exports = { createSizeRegistry, isValidDimension };
