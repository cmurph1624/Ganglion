'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseOsc52, MAX_OSC52_BYTES } = require('../renderer/clipboard');

// OSC 52 is how a program in the terminal (Claude Code, tmux, vim) puts text on the
// clipboard of the machine you are sitting at. On a headless box it is the ONLY way Claude
// Code's copy gets out, and xterm.js ignores it unless a handler is registered.
// parseOsc52() decides what that handler acts on; these tests pin it.

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('decodes a clipboard write', () => {
  assert.strictEqual(parseOsc52(`c;${b64('hello world')}`), 'hello world');
});

test('decodes UTF-8, not Latin-1', () => {
  // atob() alone yields one char per byte; without the TextDecoder step "é" arrives as
  // "Ã©" and an em dash as three characters of mojibake.
  assert.strictEqual(parseOsc52(`c;${b64('café — ✓')}`), 'café — ✓');
});

test('keeps newlines, so multi-line copies survive', () => {
  assert.strictEqual(parseOsc52(`c;${b64('line 1\nline 2\n')}`), 'line 1\nline 2\n');
});

test('accepts any selection target, including none', () => {
  // tmux sends "c", some programs send "p", "s", "c0" or leave it empty. The browser has
  // one clipboard, so the target is ignored rather than filtered.
  for (const target of ['c', 'p', 's', 'c0', 'pc', '']) {
    assert.strictEqual(parseOsc52(`${target};${b64('x')}`), 'x', JSON.stringify(target));
  }
});

test('never answers a clipboard READ request', () => {
  // "?" asks the terminal to type the clipboard back into the pty. Honouring it would let
  // anything that can print to the terminal (cat of a hostile file) read the clipboard.
  assert.strictEqual(parseOsc52('c;?'), null);
});

test('ignores a request to clear the clipboard', () => {
  assert.strictEqual(parseOsc52('c;'), null);
});

test('rejects malformed input instead of throwing', () => {
  // The handler runs inside xterm's parser; a throw there would break terminal output.
  for (const bad of ['', 'c', 'c;not base64!', 'c;@@@@', undefined, null, 42]) {
    assert.strictEqual(parseOsc52(bad), null, String(bad));
  }
});

test('refuses payloads over the size cap', () => {
  const tooBig = 'a'.repeat(MAX_OSC52_BYTES + 3);
  assert.strictEqual(parseOsc52(`c;${b64(tooBig)}`), null);
  const fits = 'a'.repeat(MAX_OSC52_BYTES);
  assert.strictEqual(parseOsc52(`c;${b64(fits)}`), fits);
});
