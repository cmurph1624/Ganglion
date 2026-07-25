'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSizeRegistry } = require('../lib/pty-sizing');

// One pty, many attached clients. Before this module, `pty:resize` retargeted the shared
// pty on every message, so two browser windows of different sizes fought continuously and
// the terminal visibly corrupted. tmux solved this long ago: the pty is sized to the
// MINIMUM over attached clients, so every client can render the full grid.
//
// The logic lives here rather than in server.js because none of it needs a socket -- and
// because the interesting cases (a client that never reported, the last client leaving)
// are exactly the ones that are painful to reproduce through a real WebSocket.

// --- effective(): the basic contract ------------------------------------------------

test('effective() is null before any client reports a size', () => {
  // Not {80,24}. Inventing a default here would resize a pty that no one has measured,
  // undoing whatever size the shell negotiated for itself.
  const sizes = createSizeRegistry();
  assert.strictEqual(sizes.effective('tab-1'), null);
});

test("a single client's size is used verbatim", () => {
  // The minimum over one entry is that entry, which is what makes this change provably
  // invisible to the existing single-browser setup.
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 120, 40);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 120, rows: 40 });
});

test('cols and rows are minimised independently across clients', () => {
  // Not "whichever client has the smaller area". A short-and-wide window plus a
  // tall-and-narrow one must yield narrow AND short, or one of them will wrap.
  const sizes = createSizeRegistry();
  sizes.set('wide-short', 'tab-1', 200, 20);
  sizes.set('narrow-tall', 'tab-1', 80, 60);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 80, rows: 20 });
});

// --- update and removal -------------------------------------------------------------

test('re-reporting from the same client replaces, never accumulates', () => {
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 200, 60);
  sizes.set('client-a', 'tab-1', 100, 30);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 100, rows: 30 });
});

test('a client shrinking re-narrows the effective size', () => {
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 200, 60);
  sizes.set('client-b', 'tab-1', 150, 50);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 150, rows: 50 });

  sizes.set('client-b', 'tab-1', 90, 25);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 90, rows: 25 });
});

test("removing the smaller client restores the larger client's size", () => {
  // This is the payoff: closing the small window must give the big window its space back,
  // not leave it stuck at the departed client's dimensions.
  const sizes = createSizeRegistry();
  sizes.set('big', 'tab-1', 200, 60);
  sizes.set('small', 'tab-1', 80, 24);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 80, rows: 24 });

  sizes.removeClient('small');
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 200, rows: 60 });
});

test('removeClient returns the tab ids it affected', () => {
  // server.js needs this to know which ptys to re-apply on disconnect. Returning every
  // known tab would resize ptys the departing client never touched.
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 100, 30);
  sizes.set('client-a', 'tab-2', 100, 30);
  sizes.set('client-b', 'tab-3', 100, 30);

  const affected = sizes.removeClient('client-a').sort();
  assert.deepStrictEqual(affected, ['tab-1', 'tab-2']);
});

test('removeClient reports nothing for a client that never reported', () => {
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 100, 30);
  assert.deepStrictEqual(sizes.removeClient('ghost'), []);
});

test('removing the last client leaves no effective size', () => {
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 100, 30);
  sizes.removeClient('client-a');
  assert.strictEqual(sizes.effective('tab-1'), null);
});

// --- per-tab isolation ---------------------------------------------------------------

test('a client that never reported for a tab does not constrain it', () => {
  // Load-bearing, and the reason absent clients are ignored rather than counted as zero:
  // renderer/styles.css hides inactive panes with `display: none`, so xterm's fitAddon
  // cannot measure them and the client never reports a size for a tab it has not opened.
  // A second window must not shrink tabs it has never looked at.
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 200, 60);
  sizes.set('client-b', 'tab-2', 80, 24);

  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 200, rows: 60 });
});

test('sizes are tracked per tab, not globally', () => {
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 200, 60);
  sizes.set('client-a', 'tab-2', 80, 24);

  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 200, rows: 60 });
  assert.deepStrictEqual(sizes.effective('tab-2'), { cols: 80, rows: 24 });
});

test("removeTab forgets every client's entry for that tab", () => {
  // Called when a pty exits or is killed. Without it a respawned tab id would inherit the
  // dimensions of clients that measured the previous, now-dead pty.
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 200, 60);
  sizes.set('client-b', 'tab-1', 80, 24);

  sizes.removeTab('tab-1');
  assert.strictEqual(sizes.effective('tab-1'), null);
});

test('removeTab leaves other tabs untouched', () => {
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 200, 60);
  sizes.set('client-a', 'tab-2', 100, 30);

  sizes.removeTab('tab-1');
  assert.deepStrictEqual(sizes.effective('tab-2'), { cols: 100, rows: 30 });
});

// --- validation ----------------------------------------------------------------------
// A resize(0, ...) can wedge a pty, and NaN propagates through Math.min to poison every
// subsequent minimum. Bad input is refused at the door rather than stored.

test('zero, negative, NaN and Infinity dimensions are rejected', () => {
  const sizes = createSizeRegistry();
  for (const [cols, rows] of [
    [0, 24],
    [80, 0],
    [-1, 24],
    [80, -1],
    [NaN, 24],
    [80, NaN],
    [Infinity, 24],
    [80, Infinity]
  ]) {
    assert.strictEqual(sizes.set('client-a', 'tab-1', cols, rows), false);
  }
  assert.strictEqual(sizes.effective('tab-1'), null);
});

test('non-integer and non-numeric dimensions are rejected', () => {
  const sizes = createSizeRegistry();
  assert.strictEqual(sizes.set('client-a', 'tab-1', 80.5, 24), false);
  assert.strictEqual(sizes.set('client-a', 'tab-1', '80', 24), false);
  assert.strictEqual(sizes.set('client-a', 'tab-1', undefined, undefined), false);
  assert.strictEqual(sizes.effective('tab-1'), null);
});

test('set() reports success for accepted dimensions', () => {
  const sizes = createSizeRegistry();
  assert.strictEqual(sizes.set('client-a', 'tab-1', 80, 24), true);
});

test('a rejected update does not disturb an accepted one', () => {
  // The failure that motivates returning a boolean: a bad message must leave the pty at
  // the last good size rather than clearing the client's entry.
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 120, 40);
  sizes.set('client-a', 'tab-1', 0, 0);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 120, rows: 40 });
});

test('the effective size never falls below 1x1', () => {
  const sizes = createSizeRegistry();
  sizes.set('client-a', 'tab-1', 1, 1);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 1, rows: 1 });
});

// --- key identity ---------------------------------------------------------------------

test('client keys may be objects (the ws instance) as well as strings', () => {
  // server.js keys the registry by the WebSocket object itself: no id to allocate, and no
  // leak, because the entry is removed in the socket's own close handler.
  const sizes = createSizeRegistry();
  const wsA = {};
  const wsB = {};

  sizes.set(wsA, 'tab-1', 200, 60);
  sizes.set(wsB, 'tab-1', 80, 24);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 80, rows: 24 });

  sizes.removeClient(wsB);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 200, rows: 60 });
});

test('two distinct client objects never collide', () => {
  // Identity, not structural equality -- two empty objects are two clients.
  const sizes = createSizeRegistry();
  sizes.set({}, 'tab-1', 200, 60);
  sizes.set({}, 'tab-1', 80, 24);
  assert.deepStrictEqual(sizes.effective('tab-1'), { cols: 80, rows: 24 });
});
