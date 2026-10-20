'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { orphanSignalFiles, expiredPastes, PASTE_MAX_AGE_MS } = require('../lib/signal-sweep');

const files = [
  'ganglion-aaa-status',
  'ganglion-aaa-tool',
  'ganglion-aaa-ingest',
  'ganglion-aaa-right-ingest',
  'ganglion-gone-status',
  'ganglion-gone-right-ingest',
  'ganglion-paste-1760000000000.png',
  'ganglion-proj-AbC123',
  'unrelated-file',
];

test('orphanSignalFiles picks only signal files of tabs not in state', () => {
  assert.deepStrictEqual(orphanSignalFiles(files, ['aaa']), ['ganglion-gone-status', 'ganglion-gone-right-ingest']);
});

test('orphanSignalFiles keeps both panes of a known tab', () => {
  assert.deepStrictEqual(orphanSignalFiles(['ganglion-aaa-right-status', 'ganglion-aaa-right-tool'], ['aaa']), []);
});

test('orphanSignalFiles deletes nothing when this instance knows no tabs', () => {
  // A scratch instance with an empty state.json must not touch the live server's files.
  assert.deepStrictEqual(orphanSignalFiles(files, []), []);
});

test('tab ids containing dashes are matched whole', () => {
  const id = '3f2c-41aa-9e0b';
  assert.deepStrictEqual(orphanSignalFiles([`ganglion-${id}-right-ingest`, `ganglion-${id}-status`], [id]), []);
  assert.deepStrictEqual(orphanSignalFiles([`ganglion-${id}-status`], ['3f2c']), [`ganglion-${id}-status`]);
});

test('expiredPastes removes only pastes older than a day', () => {
  const now = 1_800_000_000_000;
  const entries = [
    { name: 'ganglion-paste-1.png', mtimeMs: now - PASTE_MAX_AGE_MS - 1 },
    { name: 'ganglion-paste-2.jpeg', mtimeMs: now - 60_000 },
    { name: 'ganglion-aaa-status', mtimeMs: 0 },
    { name: 'ganglion-paste-notanumber.png', mtimeMs: 0 },
  ];
  assert.deepStrictEqual(expiredPastes(entries, now), ['ganglion-paste-1.png']);
});
