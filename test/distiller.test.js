'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../db/db');
const distiller = require('../memory/distiller');
const { distillSession, buildNotePrompt, buildContext } = distiller;

function seedSession(db, sessionId = 's1', slug = 'proj-x') {
  db.prepare('INSERT INTO sessions(session_id, project_slug, transcript_path) VALUES(?,?,?)').run(sessionId, slug, '/t.jsonl');
  const t = db.prepare('INSERT INTO turns(uuid, session_id, role, text) VALUES(?,?,?,?)');
  t.run('u1', sessionId, 'user', 'Always deploy the pain diary via EAS, never expo publish.');
  t.run('u2', sessionId, 'assistant', 'Understood — using eas build/submit for the Pain Diary app.');
  return slug;
}

// The distiller now emits a narrative note (plain text), not JSON facts.
const noteLLM = (text) => async () => text;

test('distillSession writes a session note into sessions.summary', async () => {
  const db = openDb(':memory:');
  seedSession(db);
  const res = await distillSession(db, 's1', {
    runLLM: noteLLM('Worked on Pain Diary deploys. Decision: use EAS build/submit, never expo publish. Left off ready to ship.')
  });
  assert.strictEqual(res.updated, true);
  const row = db.prepare("SELECT summary FROM sessions WHERE session_id='s1'").get();
  assert.match(row.summary, /EAS build\/submit/);
  db.close();
});

test('re-running regenerates (overwrites) the note', async () => {
  const db = openDb(':memory:');
  seedSession(db);
  await distillSession(db, 's1', { runLLM: noteLLM('First pass note.') });
  await distillSession(db, 's1', { runLLM: noteLLM('Second pass, more complete note.') });
  const row = db.prepare("SELECT summary FROM sessions WHERE session_id='s1'").get();
  assert.strictEqual(row.summary, 'Second pass, more complete note.');
  db.close();
});

test('empty context returns {updated:false} and never calls the LLM', async () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO sessions(session_id, project_slug, transcript_path) VALUES(?,?,?)').run('s9', 'proj-x', '/t.jsonl');
  const spy = async () => { throw new Error('LLM must not be called when there is no context'); };
  const res = await distillSession(db, 's9', { runLLM: spy });
  assert.strictEqual(res.updated, false);
  db.close();
});

test('missing session returns {updated:false}', async () => {
  const db = openDb(':memory:');
  const res = await distillSession(db, 'nope', { runLLM: noteLLM('x') });
  assert.strictEqual(res.updated, false);
  db.close();
});

test('empty/whitespace LLM output does not overwrite the summary', async () => {
  const db = openDb(':memory:');
  seedSession(db);
  const res = await distillSession(db, 's1', { runLLM: noteLLM('   \n  ') });
  assert.strictEqual(res.updated, false);
  const row = db.prepare("SELECT summary FROM sessions WHERE session_id='s1'").get();
  assert.strictEqual(row.summary, null);
  db.close();
});

test('a written note is findable end-to-end via search source:summary', async () => {
  const db = openDb(':memory:');
  seedSession(db);
  await distillSession(db, 's1', { runLLM: noteLLM('Migrated the billing webhook to idempotent retries.') });
  const { search } = require('../memory/search');
  const results = search(db, { query: 'idempotent', source: 'summary' });
  assert.ok(results.some((r) => r.sessionId === 's1'));
  db.close();
});

test('buildContext joins turns; buildNotePrompt embeds the context', () => {
  const db = openDb(':memory:');
  seedSession(db);
  const ctx = buildContext(db, 's1');
  assert.match(ctx, /expo publish/);
  const prompt = buildNotePrompt(ctx);
  assert.match(prompt, /expo publish/);
  db.close();
});
