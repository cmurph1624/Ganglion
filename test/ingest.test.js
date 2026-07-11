'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../db/db');
const { ingestTranscript } = require('../memory/ingest');

// Build a fake transcript dir so projectSlugFor() yields a stable slug.
function tmpTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ganglion-proj-'));
  return path.join(dir, 'session-abc.jsonl');
}

function line(obj) {
  return JSON.stringify(obj) + '\n';
}

const userLine = (uuid, text, extra = {}) =>
  line({ type: 'user', uuid, sessionId: 's1', parentUuid: null, timestamp: '2026-07-10T10:00:00Z', cwd: '/home/x/proj', gitBranch: 'main', message: { role: 'user', content: text }, ...extra });

const asstLine = (uuid, parent, blocks) =>
  line({ type: 'assistant', uuid, sessionId: 's1', parentUuid: parent, timestamp: '2026-07-10T10:00:05Z', cwd: '/home/x/proj', gitBranch: 'main', message: { role: 'assistant', model: 'claude-opus-4-8', content: blocks } });

test('ingests user/assistant turns and skips noise line types', () => {
  const db = openDb(':memory:');
  const f = tmpTranscript();
  fs.writeFileSync(
    f,
    line({ type: 'file-history-snapshot', uuid: 'noise1' }) +
      userLine('u1', 'how do I configure stripe webhooks') +
      line({ type: 'system', uuid: 'noise2' }) +
      asstLine('a1', 'u1', [
        { type: 'thinking', thinking: 'considering webhook signing' },
        { type: 'text', text: 'Use the Stripe CLI to forward events.' },
        { type: 'tool_use', name: 'Bash', input: {} }
      ])
  );

  const r = ingestTranscript(db, f);
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.sessionId, 's1');

  const turns = db.prepare('SELECT uuid, role, tool_names, text FROM turns ORDER BY id').all();
  assert.deepStrictEqual(turns.map((t) => t.uuid), ['u1', 'a1']);
  assert.strictEqual(turns[1].tool_names, 'Bash');
  assert.ok(turns[1].text.includes('Stripe CLI'));
  assert.ok(turns[1].text.includes('webhook signing')); // thinking flattened in

  const sess = db.prepare('SELECT turn_count, started_at, project_slug FROM sessions WHERE session_id=?').get('s1');
  assert.strictEqual(sess.turn_count, 2);
  assert.strictEqual(sess.started_at, '2026-07-10T10:00:00Z');
  db.close();
});

test('incremental re-ingest only adds appended turns', () => {
  const db = openDb(':memory:');
  const f = tmpTranscript();
  fs.writeFileSync(f, userLine('u1', 'first question'));
  const r1 = ingestTranscript(db, f);
  assert.strictEqual(r1.added, 1);

  // Nothing new -> no-op.
  const r2 = ingestTranscript(db, f);
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.offset, r1.offset);

  // Append a turn -> only the new one is ingested.
  fs.appendFileSync(f, asstLine('a1', 'u1', [{ type: 'text', text: 'the answer' }]));
  const r3 = ingestTranscript(db, f);
  assert.strictEqual(r3.added, 1);
  assert.strictEqual(db.prepare('SELECT count(*) c FROM turns').get().c, 2);
  db.close();
});

test('does not consume a partial trailing line until it is completed', () => {
  const db = openDb(':memory:');
  const f = tmpTranscript();
  // Write a complete line followed by a half-written line (no trailing newline).
  fs.writeFileSync(f, userLine('u1', 'complete line') + '{"type":"assistant","uuid":"a1","sess');
  const r1 = ingestTranscript(db, f);
  assert.strictEqual(r1.added, 1); // only the complete line

  // Now finish the partial line.
  fs.appendFileSync(f, 'ionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n');
  const r2 = ingestTranscript(db, f);
  assert.strictEqual(r2.added, 1);
  const a = db.prepare("SELECT text FROM turns WHERE uuid='a1'").get();
  assert.strictEqual(a.text, 'done');
  db.close();
});

test('idempotent on uuid even if offset is reset', () => {
  const db = openDb(':memory:');
  const f = tmpTranscript();
  fs.writeFileSync(f, userLine('u1', 'hello') + asstLine('a1', 'u1', [{ type: 'text', text: 'hi' }]));
  ingestTranscript(db, f);
  // Force a full re-scan from 0.
  db.prepare('UPDATE sessions SET ingested_bytes=0 WHERE session_id=?').run('s1');
  const r = ingestTranscript(db, f);
  assert.strictEqual(r.added, 0); // INSERT OR IGNORE dedups on uuid
  assert.strictEqual(db.prepare('SELECT count(*) c FROM turns').get().c, 2);
  db.close();
});
