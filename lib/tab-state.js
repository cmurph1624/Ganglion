'use strict';

// What belongs to the server, and what belongs to the window looking at it?
//
// Ganglion mirrors: the browser on the Mac and the desktop window on this box show the same
// tabs and the same ptys. But tab state was persisted as ONE object via a blind whole-file
// `state:save` overwrite, so the two front-ends raced -- divider positions ping-ponged, and
// across a restart a tab created in one window was dropped by the other's stale copy.
//
// The fix is not a merge protocol. The state file was holding two different kinds of thing:
//
//   shared -- what a tab IS: id, name, cwd, autoName, markdownFile. Both windows must
//             agree, so the server owns it and broadcasts every change.
//   view   -- how THIS window is looking at it: splitPosition, panelMode, and which tab is
//             active. Two windows disagreeing is correct behaviour, not a conflict. This
//             goes to localStorage and the server never sees it.
//
// Split that way there is nothing left to reconcile, which is the whole point: no merge, no
// vector clocks, no last-writer-wins.
//
// Everything here is pure -- no fs, no sockets, no `window`. server.js supplies the shared
// half and persists whatever comes back; the renderer supplies the view half from
// localStorage. That is also what makes the interesting cases testable: a client that has
// never seen a tab, a tab closed in the other window, a mutation arriving twice.

(() => {
  /**
   * The closed set of per-client keys. Everything else on a tab is shared.
   *
   * The allowlist is on the VIEW side on purpose. Shared is "whatever is left", so adding a
   * field to a tab later keeps being persisted instead of silently vanishing on the next
   * save.
   */
  const VIEW_TAB_KEYS = Object.freeze(['splitPosition', 'panelMode']);

  /**
   * What a tab looks like to a client that has no stored opinion about it.
   *
   * Load-bearing for the second front-end: the desktop window connects and learns about tabs
   * it has no localStorage for, and every one of them still has to render.
   */
  const DEFAULT_VIEW = Object.freeze({ splitPosition: 0.5, panelMode: 'hidden' });

  const VIEW_KEY_SET = new Set(VIEW_TAB_KEYS);

  /**
   * Copy an object minus the view keys.
   *
   * Used on everything inbound from a client, so a front-end that sends its whole tab object
   * cannot get its divider position written into the shared file -- exactly the leak this
   * split exists to close.
   */
  function stripViewKeys(tab) {
    const out = {};
    if (!tab || typeof tab !== 'object') return out;
    for (const [key, value] of Object.entries(tab)) {
      if (!VIEW_KEY_SET.has(key)) out[key] = value;
    }
    return out;
  }

  /** Copy only the view keys actually present, so absent ones fall through to DEFAULT_VIEW. */
  function pickViewKeys(tab) {
    const out = {};
    if (!tab || typeof tab !== 'object') return out;
    for (const key of VIEW_TAB_KEYS) {
      if (key in tab) out[key] = tab[key];
    }
    return out;
  }

  function tabsOf(state) {
    return Array.isArray(state?.tabs) ? state.tabs : [];
  }

  /**
   * Pull a legacy single-object state apart into its shared and view halves.
   *
   * Also the migration path: the existing `~/.ganglion/state.json` is exactly the input
   * shape, so the first load after this change splits it rather than discarding it.
   *
   * @param {{tabs?: object[], activeTabId?: string|null}} state
   * @returns {{shared: {tabs: object[]}, view: {tabs: Record<string, object>, activeTabId?: string}}}
   */
  function splitTabState(state) {
    const shared = { tabs: [] };
    const view = { tabs: {} };

    for (const tab of tabsOf(state)) {
      if (!tab || typeof tab !== 'object') continue;
      shared.tabs.push(stripViewKeys(tab));
      if (tab.id != null) view.tabs[tab.id] = pickViewKeys(tab);
    }

    // activeTabId is view state. Sharing it made the two windows yank each other's focus
    // around -- reading markdown on the Mac while a build runs in the desktop window is the
    // normal case, not a conflict to be resolved.
    if (state?.activeTabId != null) view.activeTabId = state.activeTabId;

    return { shared, view };
  }

  /**
   * Recombine the halves into the single object the renderer already knows how to draw.
   *
   * The shared half is authoritative about which tabs exist: view entries for tabs that are
   * gone are dropped rather than resurrected. localStorage outlives the server, so without
   * that a tab closed in the other window would come back as a ghost.
   *
   * @param {{tabs?: object[]}} shared
   * @param {{tabs?: Record<string, object>, activeTabId?: string}} view
   * @returns {{tabs: object[], activeTabId: string|null}}
   */
  function mergeTabState(shared, view) {
    const viewTabs = (view && typeof view.tabs === 'object' && view.tabs) || {};

    const tabs = tabsOf(shared).map((tab) => ({
      ...tab,
      ...DEFAULT_VIEW,
      ...pickViewKeys(viewTabs[tab?.id])
    }));

    // A remembered active tab that no longer exists falls back rather than leaving the app
    // with nothing selected.
    const ids = new Set(tabs.map((t) => t.id));
    const remembered = view?.activeTabId;
    const activeTabId = ids.has(remembered) ? remembered : (tabs.length > 0 ? tabs[0].id : null);

    return { tabs, activeTabId };
  }

  /**
   * Apply one per-tab mutation to a tab list.
   *
   * Replaces the whole-file overwrite: each client sends what actually changed, the server
   * applies it and broadcasts it, and both front-ends converge without either one shipping a
   * stale copy of the tabs it did not touch.
   *
   * Runs on both sides. On the server the input is the shared state; in the renderer it is
   * the merged tab list, which works precisely because a patch can never carry view keys --
   * so applying one preserves whatever this window had set locally.
   *
   * Always returns a NEW state object when it returns `changed: true`, and the original
   * untouched otherwise -- server.js persists only on `changed`, so an in-place mutation on
   * a refused message would already have altered what the next successful write serialises.
   *
   * Every malformed input is a no-op rather than a throw: this is fed straight off an
   * unauthenticated socket (see the no-auth constraint in CLAUDE.md), so garbage is a matter
   * of when, not if.
   *
   * @param {{tabs?: object[]}} state
   * @param {{type: string, tab?: object, tabId?: string, patch?: object}} mutation
   * @returns {{state: object, changed: boolean}}
   */
  function applyTabMutation(state, mutation) {
    const tabs = tabsOf(state);
    const unchanged = { state, changed: false };

    if (!mutation || typeof mutation !== 'object') return unchanged;

    switch (mutation.type) {
      case 'tab:created': {
        const tab = stripViewKeys(mutation.tab);
        if (typeof tab.id !== 'string' || tab.id === '') return unchanged;
        // Both front-ends echo the mutation they receive, so the originating client sees its
        // own tab come back on the broadcast. Without this it would be appended twice.
        if (tabs.some((t) => t?.id === tab.id)) return unchanged;
        return { state: { ...state, tabs: [...tabs, tab] }, changed: true };
      }

      case 'tab:closed': {
        if (typeof mutation.tabId !== 'string') return unchanged;
        const next = tabs.filter((t) => t?.id !== mutation.tabId);
        if (next.length === tabs.length) return unchanged;
        return { state: { ...state, tabs: next }, changed: true };
      }

      case 'tab:updated': {
        if (typeof mutation.tabId !== 'string') return unchanged;
        const index = tabs.findIndex((t) => t?.id === mutation.tabId);
        if (index === -1) return unchanged;

        const patch = stripViewKeys(mutation.patch);
        // The tab is addressed by mutation.tabId; letting the patch carry an id too would
        // give one message two different opinions about which tab it means.
        delete patch.id;

        // Setting a field to the value it already holds is not a change. syncCwds() polls
        // every 5s in EVERY connected front-end and both windows see the same cwd, so
        // without this the two would take turns rebroadcasting and rewriting the state file
        // with identical values for as long as Ganglion is open.
        const effective = Object.entries(patch).filter(([key, value]) => tabs[index][key] !== value);
        if (effective.length === 0) return unchanged;

        const next = tabs.slice();
        next[index] = { ...tabs[index], ...Object.fromEntries(effective) };
        return { state: { ...state, tabs: next }, changed: true };
      }

      default:
        return unchanged;
    }
  }

  const api = {
    splitTabState,
    mergeTabState,
    applyTabMutation,
    stripViewKeys,
    VIEW_TAB_KEYS,
    DEFAULT_VIEW
  };

  // Loaded three ways: require()d by server.js, require()d by test/tab-state.test.js, and
  // served to the browser as a classic <script> (see the /tab-state.js route in server.js).
  // The shared/view split has to mean the same thing on both sides of the socket, so there
  // is exactly one copy of it.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.ganglionTabState = api;
})();
