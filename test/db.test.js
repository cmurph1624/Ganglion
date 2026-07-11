'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../db/db');

test('openDb applies schema and creates all tables', () => {
  const db = openDb(':memory:');
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ['sessions', 'turns', 'memory_facts', 'documents']) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  db.close();
});

test('openDb is idempotent (safe to apply schema twice)', () => {
  const db = openDb(':memory:');
  const schema = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'db', 'schema.sql'),
    'utf8'
  );
  assert.doesNotThrow(() => db.exec(schema));
  db.close();
});

test('turns_fts stays in sync via triggers and ranks by bm25', () => {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO sessions(session_id, project_slug, transcript_path) VALUES('s1','proj','/tmp/t.jsonl')"
  ).run();
  const ins = db.prepare(
    'INSERT INTO turns(uuid, session_id, role, text) VALUES(?,?,?,?)'
  );
  ins.run('u1', 's1', 'user', 'how do I wire up stripe payment processing');
  ins.run('u2', 's1', 'assistant', 'here is unrelated content about terminals');

  const hits = db
    .prepare(
      "SELECT t.uuid FROM turns_fts f JOIN turns t ON t.id=f.rowid WHERE turns_fts MATCH 'stripe' ORDER BY bm25(turns_fts)"
    )
    .all();
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].uuid, 'u1');

  // deletion keeps FTS in sync
  db.prepare("DELETE FROM turns WHERE uuid='u1'").run();
  const after = db
    .prepare("SELECT count(*) c FROM turns_fts WHERE turns_fts MATCH 'stripe'")
    .get();
  assert.strictEqual(after.c, 0);
  db.close();
});

test('documents_fts indexes vault notes for search', () => {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO documents(path, title, body, folder) VALUES('/v/a.md','Pickleball Drills','court assignment rotation drills','20 Areas/Pickleball')"
  ).run();
  const hits = db
    .prepare(
      "SELECT d.title FROM documents_fts f JOIN documents d ON d.id=f.rowid WHERE documents_fts MATCH 'rotation'"
    )
    .all();
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].title, 'Pickleball Drills');
  db.close();
});
