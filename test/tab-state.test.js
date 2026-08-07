'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  splitTabState,
  mergeTabState,
  applyTabMutation,
  VIEW_TAB_KEYS,
  DEFAULT_VIEW
} = require('../lib/tab-state');

// Two front-ends, one state file. `state:save` used to be a blind whole-file overwrite, so
// the browser and the desktop shell clobbered each other: divider positions ping-ponged,
// and across a restart a tab created in one window was dropped by the other's stale copy.
//
// The fix is not a merge protocol. It is noticing that the state file was holding two
// different KINDS of thing:
//
//   shared  -- what a tab IS (id, name, cwd, markdownFile). Both windows must agree; the
//              server owns it and broadcasts every change.
//   view    -- how THIS window is looking at it (splitPosition, panelMode, activeTabId).
//              Two windows disagreeing is correct, not a conflict. Belongs in localStorage.
//
// Once split, there is nothing left to reconcile -- which is why this module is pure and
// testable without a socket, a file, or a browser.

// --- splitTabState(): pulling the two kinds apart -------------------------------------

test('view keys are lifted out of the tab and filed under the tab id', () => {
  const { shared, view } = splitTabState({
    tabs: [{ id: 't1', name: 'Tab 1', cwd: '/x', splitPosition: 0.3, panelMode: 'markdown' }],
    activeTabId: 't1'
  });

  assert.deepStrictEqual(shared.tabs, [{ id: 't1', name: 'Tab 1', cwd: '/x' }]);
  assert.deepStrictEqual(view.tabs.t1, { splitPosition: 0.3, panelMode: 'markdown' });
});

test('activeTabId is view state, not shared state', () => {
  // The whole point of mirroring is that two windows show the same ptys. It is not that
  // they must both be LOOKING at the same one -- reading markdown on the Mac while a build
  // runs in the desktop window is the normal case, and shared activeTabId made the two
  // windows yank each other's focus around.
  const { shared, view } = splitTabState({ tabs: [{ id: 't1' }], activeTabId: 't1' });

  assert.strictEqual(shared.activeTabId, undefined);
  assert.strictEqual(view.activeTabId, 't1');
});

test('unrecognised keys stay on the shared side', () => {
  // Shared is "everything that is not explicitly a view key" rather than an allowlist, so
  // adding a field to a tab later does not silently vanish on the next save. The allowlist
  // is on the view side, where the set is small and deliberately closed.
  const { shared } = splitTabState({ tabs: [{ id: 't1', somethingNew: 42 }] });
  assert.strictEqual(shared.tabs[0].somethingNew, 42);
});

test('a state with no tabs splits into two empty halves', () => {
  const { shared, view } = splitTabState({});
  assert.deepStrictEqual(shared.tabs, []);
  assert.deepStrictEqual(view.tabs, {});
});

// --- mergeTabState(): handing the renderer one object again ---------------------------

test('split then merge round-trips a complete state', () => {
  const original = {
    tabs: [
      { id: 't1', name: 'Tab 1', cwd: '/x', splitPosition: 0.3, panelMode: 'markdown' },
      { id: 't2', name: 'Tab 2', cwd: null, splitPosition: 0.7, panelMode: 'hidden' }
    ],
    activeTabId: 't2'
  };
  const { shared, view } = splitTabState(original);
  assert.deepStrictEqual(mergeTabState(shared, view), original);
});

test('a tab this client has never opened gets the default view', () => {
  // The load-bearing case for a second front-end. The desktop window connects and learns
  // about six tabs it has no localStorage for; every one of them must still render.
  const merged = mergeTabState({ tabs: [{ id: 't1', name: 'Tab 1' }] }, { tabs: {} });

  assert.deepStrictEqual(merged.tabs[0], { id: 't1', name: 'Tab 1', ...DEFAULT_VIEW });
});

test('view state for a tab that no longer exists is dropped, not resurrected', () => {
  // localStorage outlives the server. A tab closed in the other window must not come back
  // as a ghost just because this client still remembers where its divider was.
  const merged = mergeTabState(
    { tabs: [{ id: 't1' }] },
    { tabs: { t1: { panelMode: 'markdown' }, 'long-gone': { panelMode: 'markdown' } } }
  );

  assert.strictEqual(merged.tabs.length, 1);
  assert.strictEqual(merged.tabs[0].id, 't1');
});

test('a remembered activeTabId that no longer exists falls back to the first tab', () => {
  const merged = mergeTabState({ tabs: [{ id: 't1' }, { id: 't2' }] }, { activeTabId: 'gone' });
  assert.strictEqual(merged.activeTabId, 't1');
});

test('activeTabId is null when there are no tabs at all', () => {
  assert.strictEqual(mergeTabState({ tabs: [] }, { activeTabId: 'gone' }).activeTabId, null);
});

test('a partial view entry is completed from the defaults, not left half-set', () => {
  // panelMode alone must not leave splitPosition undefined -- the divider would render at
  // NaN% and collapse the pane.
  const merged = mergeTabState({ tabs: [{ id: 't1' }] }, { tabs: { t1: { panelMode: 'terminal' } } });

  assert.strictEqual(merged.tabs[0].panelMode, 'terminal');
  assert.strictEqual(merged.tabs[0].splitPosition, DEFAULT_VIEW.splitPosition);
});

// --- applyTabMutation(): per-tab edits instead of whole-file overwrite -----------------

test('tab:created appends the new tab', () => {
  const before = { tabs: [{ id: 't1' }] };
  const { state, changed } = applyTabMutation(before, { type: 'tab:created', tab: { id: 't2', name: 'Tab 2' } });

  assert.strictEqual(changed, true);
  assert.deepStrictEqual(state.tabs.map((t) => t.id), ['t1', 't2']);
});

test('tab:created for an id that already exists changes nothing', () => {
  // Both front-ends echo the mutation they receive. Without this the tab would be appended
  // twice -- once locally, once on the broadcast back.
  const before = { tabs: [{ id: 't1', name: 'Tab 1' }] };
  const { state, changed } = applyTabMutation(before, { type: 'tab:created', tab: { id: 't1', name: 'Impostor' } });

  assert.strictEqual(changed, false);
  assert.deepStrictEqual(state.tabs, before.tabs);
});

test('tab:created without an id is refused', () => {
  const { changed } = applyTabMutation({ tabs: [] }, { type: 'tab:created', tab: { name: 'No id' } });
  assert.strictEqual(changed, false);
});

test('tab:created strips view keys before they reach the shared file', () => {
  // A client that sends its whole tab object must not get its divider position persisted
  // server-side -- that is exactly the leak this split exists to close.
  const { state } = applyTabMutation(
    { tabs: [] },
    { type: 'tab:created', tab: { id: 't1', name: 'Tab 1', splitPosition: 0.9, panelMode: 'markdown' } }
  );

  assert.deepStrictEqual(state.tabs[0], { id: 't1', name: 'Tab 1' });
});

test('tab:closed removes just that tab', () => {
  const { state, changed } = applyTabMutation(
    { tabs: [{ id: 't1' }, { id: 't2' }] },
    { type: 'tab:closed', tabId: 't1' }
  );

  assert.strictEqual(changed, true);
  assert.deepStrictEqual(state.tabs.map((t) => t.id), ['t2']);
});

test('tab:closed for an unknown id changes nothing', () => {
  const { changed } = applyTabMutation({ tabs: [{ id: 't1' }] }, { type: 'tab:closed', tabId: 'gone' });
  assert.strictEqual(changed, false);
});

test('tab:updated merges the patch into the existing tab', () => {
  const { state, changed } = applyTabMutation(
    { tabs: [{ id: 't1', name: 'Tab 1', cwd: '/old', autoName: true }] },
    { type: 'tab:updated', tabId: 't1', patch: { cwd: '/new' } }
  );

  assert.strictEqual(changed, true);
  assert.deepStrictEqual(state.tabs[0], { id: 't1', name: 'Tab 1', cwd: '/new', autoName: true });
});

test('tab:updated refuses view keys', () => {
  // The 5s syncCwds() poll and the divider drag both call into the same save path in the
  // renderer today. Only the first of those is the server's business.
  const { state, changed } = applyTabMutation(
    { tabs: [{ id: 't1', name: 'Tab 1' }] },
    { type: 'tab:updated', tabId: 't1', patch: { splitPosition: 0.9, panelMode: 'markdown' } }
  );

  assert.strictEqual(changed, false);
  assert.deepStrictEqual(state.tabs[0], { id: 't1', name: 'Tab 1' });
});

test('tab:updated cannot rewrite the id it is addressed to', () => {
  const { state } = applyTabMutation(
    { tabs: [{ id: 't1', name: 'Tab 1' }] },
    { type: 'tab:updated', tabId: 't1', patch: { id: 'hijacked', name: 'Renamed' } }
  );

  assert.strictEqual(state.tabs[0].id, 't1');
  assert.strictEqual(state.tabs[0].name, 'Renamed');
});

test('a patch that sets a field to the value it already has is not a change', () => {
  // syncCwds() polls every 5s in EVERY connected front-end, and both windows see the same
  // cwd. Without this the two would take turns rebroadcasting and rewriting the state file
  // with identical values, forever, for as long as Ganglion is open.
  const { changed } = applyTabMutation(
    { tabs: [{ id: 't1', name: 'Tab 1', cwd: '/x' }] },
    { type: 'tab:updated', tabId: 't1', patch: { cwd: '/x' } }
  );
  assert.strictEqual(changed, false);
});

test('a partly-redundant patch applies only the part that actually differs', () => {
  const { state, changed } = applyTabMutation(
    { tabs: [{ id: 't1', name: 'Tab 1', cwd: '/x' }] },
    { type: 'tab:updated', tabId: 't1', patch: { cwd: '/x', name: 'Renamed' } }
  );

  assert.strictEqual(changed, true);
  assert.deepStrictEqual(state.tabs[0], { id: 't1', name: 'Renamed', cwd: '/x' });
});

test('a patch may still set a field that is currently absent', () => {
  // `undefined !== null`, so clearing and first-setting both count as real changes.
  const { changed } = applyTabMutation(
    { tabs: [{ id: 't1' }] },
    { type: 'tab:updated', tabId: 't1', patch: { markdownFile: null } }
  );
  assert.strictEqual(changed, true);
});

test('tab:updated for an unknown id changes nothing', () => {
  const { changed } = applyTabMutation(
    { tabs: [{ id: 't1' }] },
    { type: 'tab:updated', tabId: 'gone', patch: { name: 'x' } }
  );
  assert.strictEqual(changed, false);
});

test('an unrecognised mutation type changes nothing', () => {
  const { changed } = applyTabMutation({ tabs: [{ id: 't1' }] }, { type: 'tab:teleported', tabId: 't1' });
  assert.strictEqual(changed, false);
});

test('a malformed mutation changes nothing rather than throwing', () => {
  // handleMessage() feeds this straight off the wire. An unauthenticated socket (see the
  // no-auth constraint in CLAUDE.md) means garbage input is a matter of when, not if.
  for (const bad of [null, undefined, {}, { type: 'tab:closed' }, { type: 'tab:created' }]) {
    assert.strictEqual(applyTabMutation({ tabs: [{ id: 't1' }] }, bad).changed, false);
  }
});

// --- immutability ---------------------------------------------------------------------

test('applyTabMutation never mutates the state it was given', () => {
  // server.js persists only when `changed` is true. If the input were mutated in place, a
  // refused mutation would already have altered the in-memory state that the next
  // successful write serialises.
  const before = { tabs: [{ id: 't1', name: 'Tab 1' }] };
  const snapshot = JSON.stringify(before);

  applyTabMutation(before, { type: 'tab:created', tab: { id: 't2' } });
  applyTabMutation(before, { type: 'tab:updated', tabId: 't1', patch: { name: 'Changed' } });
  applyTabMutation(before, { type: 'tab:closed', tabId: 't1' });

  assert.strictEqual(JSON.stringify(before), snapshot);
});

test('the tab objects in a mutated state are copies, not aliases', () => {
  const before = { tabs: [{ id: 't1', name: 'Tab 1' }] };
  const { state } = applyTabMutation(before, { type: 'tab:updated', tabId: 't1', patch: { name: 'Changed' } });

  assert.notStrictEqual(state.tabs[0], before.tabs[0]);
  assert.strictEqual(before.tabs[0].name, 'Tab 1');
});

// --- the shape of the split itself ----------------------------------------------------

test('VIEW_TAB_KEYS is the closed set the rest of the module agrees on', () => {
  // Guards against a key being added to DEFAULT_VIEW without being added to the strip list,
  // which would let it leak into the shared file through tab:created.
  assert.deepStrictEqual([...VIEW_TAB_KEYS].sort(), Object.keys(DEFAULT_VIEW).sort());
});
