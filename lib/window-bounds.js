'use strict';

// Validation for the desktop window's remembered position and size.
//
// Restoring saved bounds is trivial until the display layout changes underneath them.
// Bounds written while docked to an external monitor, restored later on the laptop panel
// alone, describe a rectangle no screen covers: the window opens invisibly and the only
// way back is deleting ~/.ganglion/window.json by hand. Same for a window dragged so its
// title bar sits above the top of the screen -- still technically on screen, still
// impossible to grab with a mouse.
//
// So the persisted file is treated as untrusted input: anything that does not describe a
// reachable window is discarded, and discarding the POSITION never discards the SIZE.
//
// The display list is a parameter rather than a call into Electron's `screen` module,
// which keeps this pure and testable without an Electron runtime.

const DEFAULT_BOUNDS = { width: 1400, height: 900 };
const MIN_WIDTH = 700;
const MIN_HEIGHT = 450;

// How much of the window's width must overlap a display for it to count as reachable. A
// one-pixel sliver is visible in the geometric sense and useless in every other.
const MIN_VISIBLE_OVERLAP = 100;

/** @param {unknown} n */
function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Can the user actually see and grab this window?
 *
 * Requires meaningful horizontal overlap with some display AND a top edge inside that
 * display's vertical range -- the second condition is what rejects a window whose title
 * bar has been dragged off the top.
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds
 * @param {Array<{x: number, y: number, width: number, height: number}>} displays
 * @returns {boolean}
 */
function isReachable(bounds, displays) {
  if (!Array.isArray(displays) || displays.length === 0) return false;
  const needed = Math.min(MIN_VISIBLE_OVERLAP, bounds.width);

  return displays.some((d) => {
    if (!isFiniteNumber(d?.x) || !isFiniteNumber(d?.y)) return false;
    const overlap = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x);
    const topOnScreen = bounds.y >= d.y && bounds.y < d.y + d.height;
    return overlap >= needed && topOnScreen;
  });
}

/**
 * Turn whatever was in window.json into bounds safe to hand to BrowserWindow.
 *
 * x/y are omitted rather than defaulted when they cannot be trusted; Electron centres a
 * window with no position, which is the right answer for both a first launch and a
 * vanished monitor. Returning {x: 0, y: 0} instead would pin every such case to the
 * top-left corner.
 *
 * @param {unknown} saved
 * @param {Array<{x: number, y: number, width: number, height: number}>} displays
 * @returns {{x?: number, y?: number, width: number, height: number, maximized: boolean}}
 */
function normalizeBounds(saved, displays) {
  const raw = saved && typeof saved === 'object' ? saved : {};

  // Size and position are validated independently: a window remembered at a size worth
  // keeping should not lose it just because the monitor it sat on is gone.
  let width = DEFAULT_BOUNDS.width;
  let height = DEFAULT_BOUNDS.height;
  if (isFiniteNumber(raw.width) && isFiniteNumber(raw.height)) {
    width = Math.max(MIN_WIDTH, Math.floor(raw.width));
    height = Math.max(MIN_HEIGHT, Math.floor(raw.height));
  }

  const result = { width, height, maximized: raw.maximized === true };

  // Both coordinates or neither -- x without y would place the window at an undefined
  // vertical offset.
  if (isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
    const x = Math.floor(raw.x);
    const y = Math.floor(raw.y);
    if (isReachable({ x, y, width, height }, displays)) {
      result.x = x;
      result.y = y;
    }
  }

  return result;
}

/**
 * The shape written to disk.
 *
 * `maximized` is tracked separately from the rectangle because a maximized window reports
 * the screen's size; persisting that would lose the size to restore down to.
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds
 * @param {boolean} maximized
 */
function boundsToSave(bounds, maximized) {
  return {
    x: Math.floor(bounds.x),
    y: Math.floor(bounds.y),
    width: Math.floor(bounds.width),
    height: Math.floor(bounds.height),
    maximized: maximized === true
  };
}

module.exports = {
  DEFAULT_BOUNDS,
  MIN_WIDTH,
  MIN_HEIGHT,
  MIN_VISIBLE_OVERLAP,
  isReachable,
  normalizeBounds,
  boundsToSave
};
