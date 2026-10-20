'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, readJsonOrQuarantine } = require('../lib/atomic-write');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ganglion-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('writeFileAtomic creates the directory and file and leaves no temp files', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'nested', 'state.json');
  writeFileAtomic(file, '{"a":1}');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}');
  writeFileAtomic(file, '{"a":2}');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('writeFileAtomic keeps the existing file mode', (t) => {
  const file = path.join(tmpDir(t), 'settings.json');
  fs.writeFileSync(file, '{}', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  writeFileAtomic(file, '{"x":1}');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeFileAtomic keeps a mode the umask would narrow (664)', (t) => {
  const file = path.join(tmpDir(t), 'settings.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o664);
  const prev = process.umask(0o022);
  try {
    writeFileAtomic(file, '{"x":1}');
  } finally {
    process.umask(prev);
  }
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o664);
});

test('writeFileAtomic writes through a symlink instead of replacing it', (t) => {
  const dir = tmpDir(t);
  const real = path.join(dir, 'real.json');
  const link = path.join(dir, 'link.json');
  fs.writeFileSync(real, 'old');
  fs.symlinkSync(real, link);
  writeFileAtomic(link, 'new');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(real, 'utf8'), 'new');
});

test('a failed write leaves the old file intact and cleans up its temp file', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"old":true}');
  // Renaming a file over a non-empty directory fails, standing in for any mid-write error.
  const target = path.join(dir, 'blocker');
  fs.mkdirSync(path.join(target, 'inner'), { recursive: true });
  assert.throws(() => writeFileAtomic(target, 'new'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"old":true}');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['blocker', 'state.json']);
});

test('readJsonOrQuarantine: missing file gives the fallback', (t) => {
  const file = path.join(tmpDir(t), 'nope.json');
  assert.deepStrictEqual(readJsonOrQuarantine(file, { tabs: [] }), { tabs: [] });
});

test('readJsonOrQuarantine moves a corrupt file aside instead of letting it be overwritten', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"tabs":[{"id":"a"');
  const logs = [];
  assert.deepStrictEqual(readJsonOrQuarantine(file, { tabs: [] }, (m) => logs.push(m)), { tabs: [] });
  const names = fs.readdirSync(dir);
  assert.strictEqual(names.length, 1);
  assert.match(names[0], /^state\.json\.corrupt-\d+$/);
  assert.strictEqual(fs.readFileSync(path.join(dir, names[0]), 'utf8'), '{"tabs":[{"id":"a"');
  assert.strictEqual(logs.length, 1);
});
