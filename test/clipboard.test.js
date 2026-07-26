'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { writeClipboard } = require('../renderer/clipboard');

// Why this is not simply `navigator.clipboard.writeText(...)`:
//
// The async Clipboard API is gated behind a *secure context*. Ganglion binds 0.0.0.0 and is
// reached from the Mac as http://<lan-ip>:3000, which is plain HTTP and therefore not
// secure -- so `navigator.clipboard` is undefined in that front-end while being perfectly
// available in the local browser and in Electron, both of which count as secure. A copy
// written against the modern API alone would work on this machine, pass review, and then do
// nothing at all from the Mac, silently.
//
// So the writer takes both paths and its dependencies are injected, which also lets the
// whole thing be tested under node:test with no DOM.

/** A stand-in for navigator.clipboard. */
function fakeClipboard(behaviour = 'ok') {
  const calls = [];
  return {
    calls,
    writeText(text) {
      calls.push(text);
      return behaviour === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied'));
    }
  };
}

test('writeClipboard uses the async clipboard API when it is available', async () => {
  const clipboard = fakeClipboard();
  const ok = await writeClipboard('hello', { clipboard, fallback: () => false });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(clipboard.calls, ['hello']);
});

test('writeClipboard does not reach for the fallback when the modern path works', async () => {
  let fallbackCalls = 0;
  await writeClipboard('hello', { clipboard: fakeClipboard(), fallback: () => { fallbackCalls++; return true; } });
  assert.strictEqual(fallbackCalls, 0);
});

test('writeClipboard falls back when the clipboard API is missing', async () => {
  // This is the Mac-over-plain-HTTP case: navigator.clipboard is simply not there.
  const copied = [];
  const ok = await writeClipboard('hello', { clipboard: undefined, fallback: (t) => { copied.push(t); return true; } });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(copied, ['hello']);
});

test('writeClipboard falls back when the clipboard API rejects', async () => {
  // Permission can be denied at call time even where the API exists -- a rejected promise
  // must not be the end of the attempt.
  const copied = [];
  const ok = await writeClipboard('hello', { clipboard: fakeClipboard('reject'), fallback: (t) => { copied.push(t); return true; } });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(copied, ['hello']);
});

test('writeClipboard falls back when the clipboard object has no writeText', async () => {
  const ok = await writeClipboard('hello', { clipboard: {}, fallback: () => true });
  assert.strictEqual(ok, true);
});

test('writeClipboard reports failure when both paths fail', async () => {
  // The caller has already told xterm not to send SIGINT by this point, so it needs to know
  // the copy did not happen rather than assume it did.
  const ok = await writeClipboard('hello', { clipboard: fakeClipboard('reject'), fallback: () => false });
  assert.strictEqual(ok, false);
});

test('writeClipboard survives a fallback that throws', async () => {
  // execCommand throws in some embedded contexts. This runs inside a keydown handler.
  const ok = await writeClipboard('hello', {
    clipboard: undefined,
    fallback: () => { throw new Error('execCommand unavailable'); }
  });
  assert.strictEqual(ok, false);
});

test('writeClipboard treats empty text as nothing to do', async () => {
  // Ctrl+Shift+C with nothing selected. Writing an empty string would clear whatever the
  // user already had on the clipboard.
  let attempts = 0;
  const deps = { clipboard: fakeClipboard(), fallback: () => { attempts++; return true; } };
  assert.strictEqual(await writeClipboard('', deps), false);
  assert.strictEqual(await writeClipboard(null, deps), false);
  assert.strictEqual(await writeClipboard(undefined, deps), false);
  assert.strictEqual(deps.clipboard.calls.length, 0);
  assert.strictEqual(attempts, 0);
});

test('writeClipboard preserves whitespace-only-looking content that is not empty', async () => {
  // Indentation matters when copying code out of a terminal; only a genuinely empty string
  // is skipped.
  const clipboard = fakeClipboard();
  assert.strictEqual(await writeClipboard('    ', { clipboard }), true);
  assert.deepStrictEqual(clipboard.calls, ['    ']);
});

test('writeClipboard reports failure when given no dependencies at all', async () => {
  assert.strictEqual(await writeClipboard('hello', {}), false);
  assert.strictEqual(await writeClipboard('hello'), false);
});
