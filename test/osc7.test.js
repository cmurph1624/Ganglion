'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseOsc7Uri, createCwdTracker } = require('../lib/osc7');

// Windows exposes no supported way to read another process's cwd, so `lsof -d cwd` has no
// counterpart and cwdProbe() returns null there. The shell must therefore volunteer the
// information: it emits OSC 7 from its prompt and the server reads it back out of the pty
// stream. Everything below guards that channel, because when it breaks the only symptom is
// a tab name that quietly never changes.

// --- parseOsc7Uri -------------------------------------------------------------------

test('parseOsc7Uri decodes a Windows path and returns it in native form', () => {
  // The drive letter's colon is percent-encoded by the emitter (EscapeDataString), so the
  // raw payload is not a readable path until it is decoded.
  assert.equal(parseOsc7Uri('file://STIGMERGYLABS/C%3A/Users/rdpuser'), 'C:\\Users\\rdpuser');
});

test('parseOsc7Uri keeps POSIX paths POSIX', () => {
  assert.equal(parseOsc7Uri('file://chris-c-series/home/chris/dev'), '/home/chris/dev');
});

test('parseOsc7Uri accepts an empty host', () => {
  // file:///path is the more common spelling and is equally valid.
  assert.equal(parseOsc7Uri('file:///home/chris'), '/home/chris');
  assert.equal(parseOsc7Uri('file:///C%3A/Users/rdpuser'), 'C:\\Users\\rdpuser');
});

test('parseOsc7Uri decodes percent-escaped spaces and literal percent signs', () => {
  // A directory called "100%" round-trips only because the emitter escapes per path
  // segment; EscapeUriString would have left the bare % and produced a decode error here.
  assert.equal(parseOsc7Uri('file://h/C%3A/My%20Repos/100%25'), 'C:\\My Repos\\100%');
});

test('parseOsc7Uri rejects anything that is not a file URI', () => {
  // OSC 7 is defined for file:// only; a shell emitting something else is not reporting a
  // directory this server can hand back to a tab.
  assert.equal(parseOsc7Uri('http://example.com/x'), null);
  assert.equal(parseOsc7Uri(''), null);
  assert.equal(parseOsc7Uri('file://host'), null);
});

test('parseOsc7Uri rejects an undecodable payload rather than throwing', () => {
  // decodeURIComponent throws on a truncated escape. A malformed sequence in the output
  // stream must not take down the pty data handler that feeds it.
  assert.equal(parseOsc7Uri('file://h/C%3A/bad%ZZ'), null);
});

// --- createCwdTracker ---------------------------------------------------------------

test('createCwdTracker starts with no opinion', () => {
  assert.equal(createCwdTracker().cwd, null);
});

test('createCwdTracker picks the cwd out of surrounding terminal output', () => {
  const t = createCwdTracker();
  const out = t.push('some output\r\n\x1b]7;file://h/C%3A/Users/rdpuser\x07PS C:\\Users\\rdpuser> ');
  assert.equal(out, 'C:\\Users\\rdpuser');
  assert.equal(t.cwd, 'C:\\Users\\rdpuser');
});

test('createCwdTracker accepts the ST terminator as well as BEL', () => {
  // xterm terminates OSC with either BEL or ESC-backslash; both are legal and which one
  // appears depends on the emitter.
  const t = createCwdTracker();
  assert.equal(t.push('\x1b]7;file://h/home/chris\x1b\\'), '/home/chris');
});

test('createCwdTracker reassembles a sequence split across chunks', () => {
  // The pty hands over whatever bytes are ready, so an escape sequence is routinely torn in
  // half. Parsing each chunk independently would drop exactly the updates we care about.
  const t = createCwdTracker();
  assert.equal(t.push('\x1b]7;file://h/C%3A/Us'), null);
  assert.equal(t.cwd, null);
  assert.equal(t.push('ers/rdpuser\x07'), 'C:\\Users\\rdpuser');
});

test('createCwdTracker survives a sequence split inside the escape prefix', () => {
  const t = createCwdTracker();
  assert.equal(t.push('output\x1b'), null);
  assert.equal(t.push(']7;file://h/home/chris\x07'), '/home/chris');
});

test('createCwdTracker reports only the last cwd in a chunk', () => {
  // A replayed buffer or a burst of prompts can carry several; only the newest is current.
  const t = createCwdTracker();
  const out = t.push('\x1b]7;file://h/home/a\x07x\x1b]7;file://h/home/b\x07');
  assert.equal(out, '/home/b');
});

test('createCwdTracker reports null when the cwd has not changed', () => {
  // The prompt fires on every command, so an unchanged directory is the common case. The
  // caller uses the return value to decide whether anything needs broadcasting.
  const t = createCwdTracker();
  assert.equal(t.push('\x1b]7;file://h/home/chris\x07'), '/home/chris');
  assert.equal(t.push('\x1b]7;file://h/home/chris\x07'), null);
  assert.equal(t.cwd, '/home/chris');
});

test('createCwdTracker ignores OSC sequences that are not OSC 7', () => {
  // OSC 0 (window title) is emitted constantly and contains arbitrary text.
  const t = createCwdTracker();
  assert.equal(t.push('\x1b]0;file://h/home/chris\x07'), null);
  assert.equal(t.cwd, null);
  // OSC 7 must not be matched as a prefix of OSC 70-something either.
  assert.equal(t.push('\x1b]77;file://h/home/chris\x07'), null);
  assert.equal(t.cwd, null);
});

test('createCwdTracker does not grow without bound on an unterminated sequence', () => {
  // A stray ESC ] 7 ; with no terminator would otherwise pin every subsequent byte of
  // terminal output in memory for the life of the tab.
  const t = createCwdTracker();
  t.push('\x1b]7;file://h/home/');
  for (let i = 0; i < 200; i++) t.push('x'.repeat(100));
  assert.ok(t.pending() < 8192, `carry grew to ${t.pending()} bytes`);
});

test('createCwdTracker keeps working after abandoning an unterminated sequence', () => {
  const t = createCwdTracker();
  t.push('\x1b]7;file://h/home/');
  for (let i = 0; i < 200; i++) t.push('x'.repeat(100));
  assert.equal(t.push('\x1b]7;file://h/home/chris\x07'), '/home/chris');
});

test('createCwdTracker ignores a cwd it cannot parse', () => {
  const t = createCwdTracker();
  assert.equal(t.push('\x1b]7;\x07'), null);
  assert.equal(t.cwd, null);
});
