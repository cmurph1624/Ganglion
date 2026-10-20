'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sb = require('../lib/scrollback');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-scrollback-'));

test('fileFor refuses ids that could escape the directory', () => {
  assert.strictEqual(sb.fileFor('/d', '../etc/passwd'), null);
  assert.strictEqual(sb.fileFor('/d', 'a/b'), null);
  assert.strictEqual(sb.fileFor('/d', ''), null);
  assert.strictEqual(sb.fileFor('/d', 42), null);
  assert.strictEqual(sb.fileFor('/d', 'abc-123-right'), path.join('/d', 'abc-123-right.log'));
});

test('restoredBuffer: empty stays empty; otherwise text, reset, separator, capped', () => {
  assert.strictEqual(sb.restoredBuffer(''), '');
  const out = sb.restoredBuffer('hello');
  assert.ok(out.startsWith('hello'));
  assert.ok(out.includes('\x1b[?1049l'));
  assert.ok(out.endsWith(sb.SEPARATOR));
  const big = sb.restoredBuffer('x'.repeat(sb.MAX_BYTES + 100));
  assert.strictEqual(big.length, sb.MAX_BYTES);
  assert.ok(big.endsWith(sb.SEPARATOR));
});

test('save/load/remove round trip, files are private', async () => {
  const dir = path.join(tmpDir(), 'scrollback');
  await sb.save(dir, 't1', 'one');
  assert.strictEqual(sb.load(dir, 't1'), 'one');
  sb.saveSync(dir, 't1', 'two');
  assert.strictEqual(sb.load(dir, 't1'), 'two');
  assert.strictEqual(fs.statSync(path.join(dir, 't1.log')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  sb.remove(dir, 't1');
  assert.strictEqual(sb.load(dir, 't1'), '');
  assert.strictEqual(sb.load(dir, '../x'), '');
});

test('orphanFiles keeps live tabs and their right panes, drops the rest and temp files', () => {
  const names = ['a.log', 'a-right.log', 'b.log', 'b-right.log', 'a.log.123.tmp', 'notes.txt'];
  assert.deepStrictEqual(sb.orphanFiles(names, ['a']), ['b.log', 'b-right.log', 'a.log.123.tmp']);
});

test('prune deletes orphans on disk', () => {
  const dir = tmpDir();
  for (const n of ['a.log', 'b.log']) fs.writeFileSync(path.join(dir, n), 'x');
  assert.strictEqual(sb.prune(dir, ['a']), 1);
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.log']);
  assert.strictEqual(sb.prune(path.join(dir, 'missing'), ['a']), 0);
});
