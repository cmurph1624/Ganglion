'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../db/db');
const { indexVault, indexFile, parseNote } = require('../memory/index-vault');

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ganglion-vault-'));
}

test('parseNote extracts title, block-list tags, and strips frontmatter', () => {
  const { title, tags, body } = parseNote(
    '---\ntitle: Pickleball Drills\ntags:\n  - Pickleball\n  - drills\n---\nRotation drill notes here.'
  );
  assert.strictEqual(title, 'Pickleball Drills');
  assert.deepStrictEqual(tags, ['Pickleball', 'drills']);
  assert.strictEqual(body.trim(), 'Rotation drill notes here.');
});

test('parseNote handles inline-array tags and no frontmatter', () => {
  assert.deepStrictEqual(parseNote('---\ntags: [a, b, c]\n---\nbody').tags, ['a', 'b', 'c']);
  const plain = parseNote('# Just a note\ncontent');
  assert.strictEqual(plain.title, null);
  assert.strictEqual(plain.body, '# Just a note\ncontent');
});

test('indexVault indexes notes and derives folder, title falls back to filename', () => {
  const db = openDb(':memory:');
  const vault = tmpVault();
  fs.mkdirSync(path.join(vault, '20 Areas', 'Pickleball'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '20 Areas', 'Pickleball', 'Drills.md'),
    '---\ntags:\n  - Pickleball\n---\ncourt rotation assignments'
  );
  fs.writeFileSync(path.join(vault, 'Loose Note.md'), 'no frontmatter body');

  const res = indexVault(db, { vaultRoot: vault });
  assert.strictEqual(res.scanned, 2);
  assert.strictEqual(res.indexed, 2);

  const drills = db.prepare("SELECT * FROM documents WHERE title='Drills'").get();
  assert.strictEqual(drills.folder, path.join('20 Areas', 'Pickleball'));
  assert.strictEqual(drills.tags, 'Pickleball');

  const loose = db.prepare("SELECT title FROM documents WHERE path LIKE '%Loose Note.md'").get();
  assert.strictEqual(loose.title, 'Loose Note'); // filename fallback

  // FTS works over notes.
  const hit = db
    .prepare("SELECT d.title FROM documents_fts f JOIN documents d ON d.id=f.rowid WHERE documents_fts MATCH 'rotation'")
    .all();
  assert.strictEqual(hit.length, 1);
  db.close();
});

test('indexVault is mtime-incremental and prunes deleted notes', () => {
  const db = openDb(':memory:');
  const vault = tmpVault();
  const f = path.join(vault, 'a.md');
  fs.writeFileSync(f, 'original');
  assert.strictEqual(indexVault(db, { vaultRoot: vault }).indexed, 1);

  // Unchanged -> skipped.
  const second = indexVault(db, { vaultRoot: vault });
  assert.strictEqual(second.indexed, 0);
  assert.strictEqual(second.skipped, 1);

  // Delete the file -> pruned from index.
  fs.unlinkSync(f);
  const third = indexVault(db, { vaultRoot: vault });
  assert.strictEqual(third.scanned, 0);
  assert.strictEqual(db.prepare('SELECT count(*) c FROM documents').get().c, 0);
  db.close();
});

test('indexFile removes a note when its file is gone', () => {
  const db = openDb(':memory:');
  const vault = tmpVault();
  const f = path.join(vault, 'gone.md');
  fs.writeFileSync(f, 'temp');
  indexFile(db, f, vault);
  assert.strictEqual(db.prepare('SELECT count(*) c FROM documents').get().c, 1);
  fs.unlinkSync(f);
  const wrote = indexFile(db, f, vault);
  assert.strictEqual(wrote, false);
  assert.strictEqual(db.prepare('SELECT count(*) c FROM documents').get().c, 0);
  db.close();
});
