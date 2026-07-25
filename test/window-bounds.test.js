'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_BOUNDS,
  MIN_WIDTH,
  MIN_HEIGHT,
  normalizeBounds,
  boundsToSave
} = require('../lib/window-bounds');

// Remembering where the desktop window was is trivial until the display layout changes
// underneath it. Bounds saved while docked to an external monitor, restored on the laptop
// panel alone, put the window at coordinates no screen covers -- it opens invisibly, with
// no way to recover it except deleting the file by hand. So every persisted value is
// treated as untrusted input.
//
// The display list is injected rather than read from Electron's `screen` module, which
// keeps this pure and testable without an Electron runtime.

/** A single 1920x1080 monitor at the origin. */
const ONE_DISPLAY = [{ x: 0, y: 0, width: 1920, height: 1080 }];

/** A laptop panel with a second monitor to its left, at negative x. */
const TWO_DISPLAYS = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: -1920, y: 0, width: 1920, height: 1080 }
];

// --- defaults --------------------------------------------------------------------------

test('returns the default 1400x900 bounds when nothing is persisted', () => {
  const b = normalizeBounds(null, ONE_DISPLAY);
  assert.strictEqual(b.width, 1400);
  assert.strictEqual(b.height, 900);
});

test('omits x and y when nothing is persisted, so the OS centres the window', () => {
  // Returning x:0,y:0 would pin every first launch to the top-left corner.
  const b = normalizeBounds(null, ONE_DISPLAY);
  assert.strictEqual(b.x, undefined);
  assert.strictEqual(b.y, undefined);
});

test('the exported defaults match the window the app actually asks for', () => {
  assert.strictEqual(DEFAULT_BOUNDS.width, 1400);
  assert.strictEqual(DEFAULT_BOUNDS.height, 900);
  assert.strictEqual(MIN_WIDTH, 700);
  assert.strictEqual(MIN_HEIGHT, 450);
});

// --- malformed input ---------------------------------------------------------------------

test('rejects malformed, partial or non-numeric saved bounds', () => {
  for (const saved of [
    undefined,
    null,
    'not an object',
    42,
    {},
    { width: 1000 },
    { height: 700 },
    { width: 'wide', height: 700 },
    { width: NaN, height: 700 },
    { width: Infinity, height: 700 },
    { width: 1000, height: null }
  ]) {
    const b = normalizeBounds(saved, ONE_DISPLAY);
    assert.strictEqual(b.width, 1400, `saved=${JSON.stringify(saved)}`);
    assert.strictEqual(b.height, 900, `saved=${JSON.stringify(saved)}`);
  }
});

test('a partial position is discarded rather than half-applied', () => {
  // x without y would place the window at an undefined vertical offset.
  const b = normalizeBounds({ width: 1000, height: 700, x: 100 }, ONE_DISPLAY);
  assert.strictEqual(b.x, undefined);
  assert.strictEqual(b.y, undefined);
  assert.strictEqual(b.width, 1000);
});

// --- size clamping -------------------------------------------------------------------

test('clamps a window below the 700x450 minimum', () => {
  const b = normalizeBounds({ width: 200, height: 100 }, ONE_DISPLAY);
  assert.strictEqual(b.width, MIN_WIDTH);
  assert.strictEqual(b.height, MIN_HEIGHT);
});

test('keeps a size at exactly the minimum', () => {
  const b = normalizeBounds({ width: MIN_WIDTH, height: MIN_HEIGHT }, ONE_DISPLAY);
  assert.strictEqual(b.width, MIN_WIDTH);
  assert.strictEqual(b.height, MIN_HEIGHT);
});

test('floors fractional sizes that come back from a scaled display', () => {
  const b = normalizeBounds({ width: 1000.6, height: 700.2 }, ONE_DISPLAY);
  assert.strictEqual(b.width, 1000);
  assert.strictEqual(b.height, 700);
});

// --- visibility ----------------------------------------------------------------------

test('keeps bounds that overlap a display', () => {
  const b = normalizeBounds({ width: 1000, height: 700, x: 200, y: 150 }, ONE_DISPLAY);
  assert.strictEqual(b.x, 200);
  assert.strictEqual(b.y, 150);
});

test('recentres bounds lying entirely outside every display', () => {
  // The docked-then-undocked case: saved on a monitor that is no longer attached.
  const b = normalizeBounds({ width: 1000, height: 700, x: -3000, y: 0 }, ONE_DISPLAY);
  assert.strictEqual(b.x, undefined);
  assert.strictEqual(b.y, undefined);
  assert.strictEqual(b.width, 1000, 'size survives even when the position does not');
});

test('keeps bounds on a secondary display at negative coordinates', () => {
  // Negative x is perfectly normal for a monitor placed to the left of the primary; it
  // must not be mistaken for "off screen".
  const b = normalizeBounds({ width: 1000, height: 700, x: -1800, y: 100 }, TWO_DISPLAYS);
  assert.strictEqual(b.x, -1800);
  assert.strictEqual(b.y, 100);
});

test('recentres a window whose title bar is above every display', () => {
  // Dragged-off-the-top is unrecoverable by mouse, so it counts as invisible even though
  // the rectangle technically intersects the screen.
  const b = normalizeBounds({ width: 1000, height: 700, x: 200, y: -690 }, ONE_DISPLAY);
  assert.strictEqual(b.y, undefined);
});

test('treats an empty display list as "cannot verify" and drops the position', () => {
  const b = normalizeBounds({ width: 1000, height: 700, x: 200, y: 150 }, []);
  assert.strictEqual(b.x, undefined);
  assert.strictEqual(b.width, 1000);
});

// --- maximized ------------------------------------------------------------------------

test('preserves the maximized flag independently of the restore bounds', () => {
  const b = normalizeBounds({ width: 1000, height: 700, x: 10, y: 10, maximized: true }, ONE_DISPLAY);
  assert.strictEqual(b.maximized, true);
  assert.strictEqual(b.width, 1000, 'the pre-maximize size is what we restore to');
});

test('defaults maximized to false when absent or not a boolean', () => {
  assert.strictEqual(normalizeBounds({ width: 1000, height: 700 }, ONE_DISPLAY).maximized, false);
  assert.strictEqual(normalizeBounds({ width: 1000, height: 700, maximized: 'yes' }, ONE_DISPLAY).maximized, false);
  assert.strictEqual(normalizeBounds(null, ONE_DISPLAY).maximized, false);
});

// --- round trip -----------------------------------------------------------------------

test('boundsToSave keeps only the fields we persist', () => {
  const saved = boundsToSave({ x: 10, y: 20, width: 1000, height: 700 }, true);
  assert.deepStrictEqual(saved, { x: 10, y: 20, width: 1000, height: 700, maximized: true });
});

test('round-trips through JSON unchanged', () => {
  const saved = boundsToSave({ x: 10, y: 20, width: 1000, height: 700 }, false);
  const restored = normalizeBounds(JSON.parse(JSON.stringify(saved)), ONE_DISPLAY);
  assert.strictEqual(restored.x, 10);
  assert.strictEqual(restored.y, 20);
  assert.strictEqual(restored.width, 1000);
  assert.strictEqual(restored.height, 700);
  assert.strictEqual(restored.maximized, false);
});
