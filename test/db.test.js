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
  for (const t of ['sessions', 'turns', 'documents']) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  db.close();
});

test('memory_facts is retired (not created on a fresh DB)', () => {
  const db = openDb(':memory:');
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(!names.includes('memory_facts'), 'memory_facts should no longer exist');
  db.close();
});

test('sessions_fts stays in sync with sessions.summary via triggers', () => {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO sessions(session_id, project_slug, transcript_path) VALUES('s1','proj','/tmp/t.jsonl')"
  ).run();

  // A session with a NULL summary is not matchable.
  assert.strictEqual(
    db.prepare("SELECT count(*) c FROM sessions_fts WHERE sessions_fts MATCH 'webhook'").get().c,
    0
  );

  // Setting the summary indexes it (the external-content delete-of-NULL must not throw).
  db.prepare("UPDATE sessions SET summary='refactored the stripe webhook retry logic' WHERE session_id='s1'").run();
  const hits = db
    .prepare("SELECT s.session_id FROM sessions_fts f JOIN sessions s ON s.rowid=f.rowid WHERE sessions_fts MATCH 'webhook'")
    .all();
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].session_id, 's1');

  // Regenerating the note replaces the old text (delete old + insert new).
  db.prepare("UPDATE sessions SET summary='now about pickleball court rotation' WHERE session_id='s1'").run();
  assert.strictEqual(
    db.prepare("SELECT count(*) c FROM sessions_fts WHERE sessions_fts MATCH 'webhook'").get().c,
    0
  );
  assert.strictEqual(
    db.prepare("SELECT count(*) c FROM sessions_fts WHERE sessions_fts MATCH 'pickleball'").get().c,
    1
  );
  db.close();
});

test('routine (non-summary) session updates do not churn or corrupt sessions_fts', () => {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO sessions(session_id, project_slug, transcript_path) VALUES('s1','proj','/tmp/t.jsonl')"
  ).run();
  db.prepare("UPDATE sessions SET summary='indexed billing note' WHERE session_id='s1'").run();
  // An ingest-style update that never touches summary (AFTER UPDATE OF summary must not fire).
  db.prepare("UPDATE sessions SET ended_at='2026-07-22T00:00:00Z', turn_count=5 WHERE session_id='s1'").run();
  assert.strictEqual(
    db.prepare("SELECT count(*) c FROM sessions_fts WHERE sessions_fts MATCH 'billing'").get().c,
    1
  );
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

test('openDb adds distilled_turns to a sessions table created before the column existed', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ganglion-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_slug TEXT NOT NULL,
    project_path TEXT, transcript_path TEXT NOT NULL, git_branch TEXT, started_at TEXT, ended_at TEXT,
    turn_count INTEGER DEFAULT 0, ingested_bytes INTEGER DEFAULT 0, summary TEXT, status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
  old.prepare("INSERT INTO sessions(session_id, project_slug, transcript_path, summary) VALUES('s', 'p', '/t', 'note')").run();
  old.close();
  const { openDb: open } = require('../db/db');
  const db = open(file);
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  assert.ok(cols.includes('distilled_turns'));
  assert.strictEqual(db.prepare("SELECT summary FROM sessions WHERE session_id='s'").get().summary, 'note');
  db.close();
  open(file).close(); // idempotent: a second open must not try to add it again
});
