'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { orphanSignalFiles, expiredPastes, PASTE_MAX_AGE_MS, SIGNAL_MIN_AGE_MS } = require('../lib/signal-sweep');

const NOW = 1_800_000_000_000;
const OLD = NOW - SIGNAL_MIN_AGE_MS - 1;
const RECENT = NOW - 60_000;
const e = (name, mtimeMs = OLD) => ({ name, mtimeMs });

const entries = [
  e('ganglion-aaa-status'),
  e('ganglion-aaa-tool'),
  e('ganglion-aaa-ingest'),
  e('ganglion-aaa-right-ingest'),
  e('ganglion-gone-status'),
  e('ganglion-gone-right-ingest'),
  e('ganglion-paste-1760000000000.png'),
  e('ganglion-proj-AbC123'),
  e('unrelated-file'),
];

test('orphanSignalFiles picks only old signal files of tabs not in state', () => {
  assert.deepStrictEqual(orphanSignalFiles(entries, ['aaa'], NOW), ['ganglion-gone-status', 'ganglion-gone-right-ingest']);
});

test('orphanSignalFiles keeps a recently touched file even if its tab is unknown', () => {
  // Another instance's live tab: unknown to us, but its hooks keep writing.
  assert.deepStrictEqual(orphanSignalFiles([e('ganglion-other-status', RECENT)], ['aaa'], NOW), []);
});

test('orphanSignalFiles keeps both panes of a known tab', () => {
  assert.deepStrictEqual(orphanSignalFiles([e('ganglion-aaa-right-status'), e('ganglion-aaa-right-tool')], ['aaa'], NOW), []);
});

test('orphanSignalFiles deletes nothing when this instance knows no tabs', () => {
  assert.deepStrictEqual(orphanSignalFiles(entries, [], NOW), []);
});

test('tab ids containing dashes are matched whole', () => {
  const id = '3f2c-41aa-9e0b';
  assert.deepStrictEqual(orphanSignalFiles([e(`ganglion-${id}-right-ingest`), e(`ganglion-${id}-status`)], [id], NOW), []);
  assert.deepStrictEqual(orphanSignalFiles([e(`ganglion-${id}-status`)], ['3f2c'], NOW), [`ganglion-${id}-status`]);
});

test('expiredPastes removes only pastes older than a day', () => {
  const list = [
    { name: 'ganglion-paste-1.png', mtimeMs: NOW - PASTE_MAX_AGE_MS - 1 },
    { name: 'ganglion-paste-2.jpeg', mtimeMs: RECENT },
    { name: 'ganglion-aaa-status', mtimeMs: 0 },
    { name: 'ganglion-paste-notanumber.png', mtimeMs: 0 },
  ];
  assert.deepStrictEqual(expiredPastes(list, NOW), ['ganglion-paste-1.png']);
});
