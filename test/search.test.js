'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../db/db');
const { search, getSession, getTurn, buildFtsQuery } = require('../memory/search');

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO sessions(session_id, project_slug, transcript_path, status) VALUES('s1','proj-ditd','/t/s1.jsonl','completed')").run();
  db.prepare("INSERT INTO sessions(session_id, project_slug, transcript_path, status) VALUES('s2','proj-ganglion','/t/s2.jsonl','idle')").run();
  const t = db.prepare('INSERT INTO turns(uuid, session_id, role, ts, text, tool_names) VALUES(?,?,?,?,?,?)');
  t.run('u1', 's1', 'user', '2026-06-01T10:00:00Z', 'how do I set up stripe billing for the pain diary', null);
  t.run('u2', 's1', 'assistant', '2026-06-01T10:01:00Z', 'configure the stripe webhook endpoint', 'Bash');
  t.run('u3', 's2', 'user', '2026-07-01T10:00:00Z', 'stripe came up while building the terminal', null);
  db.prepare("INSERT INTO documents(path, title, body, folder, mtime) VALUES('/v/Billing.md','Billing Notes','stripe pricing tiers and billing cadence','10 Projects/DITD',1750000000000)").run();
  // A distilled session note lives on the session row (the distiller writes it here).
  db.prepare("UPDATE sessions SET summary='set up stripe billing webhooks for the pain diary; left off on retry handling' WHERE session_id='s1'").run();
  return db;
}

test('buildFtsQuery tokenizes and phrase-quotes, tolerating punctuation', () => {
  assert.strictEqual(buildFtsQuery('stripe billing'), '"stripe" "billing"');
  assert.strictEqual(buildFtsQuery('  "weird" OR-punct!  '), '"weird" "OR" "punct"');
  assert.strictEqual(buildFtsQuery('   '), '');
});

test('search spans sessions and notes, cited by source', () => {
  const db = seed();
  const results = search(db, { query: 'stripe' });
  const sources = new Set(results.map((r) => r.source));
  assert.ok(sources.has('session'), 'has session hits');
  assert.ok(sources.has('note'), 'has note hits');
  const note = results.find((r) => r.source === 'note');
  assert.strictEqual(note.title, 'Billing Notes');
  assert.strictEqual(note.project, '10 Projects/DITD');
  const sess = results.find((r) => r.source === 'session');
  assert.ok(sess.sessionId);
  assert.ok(sess.snippet.includes('\u0001')); // highlighted
  db.close();
});

test('source filter restricts to notes only', () => {
  const db = seed();
  const results = search(db, { query: 'stripe', source: 'note' });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.source === 'note'));
  db.close();
});

test('search surfaces distilled session notes as source "summary"', () => {
  const db = seed();
  const results = search(db, { query: 'stripe' });
  const summary = results.find((r) => r.source === 'summary');
  assert.ok(summary, 'has a session-note hit');
  assert.strictEqual(summary.sessionId, 's1');
  assert.strictEqual(summary.project, 'proj-ditd');
  assert.ok(summary.snippet.includes('\u0001')); // highlighted
  db.close();
});

test('source filter restricts to session notes only', () => {
  const db = seed();
  const results = search(db, { query: 'stripe', source: 'summary' });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.source === 'summary'));
  db.close();
});

test('session-note results respect the project and date filters', () => {
  const db = seed();
  const ditd = search(db, { query: 'stripe', source: 'summary', project: 'proj-ditd' });
  assert.ok(ditd.length >= 1);
  assert.ok(ditd.every((r) => r.project === 'proj-ditd'));

  const none = search(db, { query: 'stripe', source: 'summary', project: 'proj-ganglion' });
  assert.strictEqual(none.length, 0);
  db.close();
});

test('structured filters: project and date range narrow session hits', () => {
  const db = seed();
  const ditd = search(db, { query: 'stripe', source: 'session', project: 'proj-ditd' });
  assert.ok(ditd.every((r) => r.project === 'proj-ditd'));

  const early = search(db, { query: 'stripe', source: 'session', dateTo: '2026-06-30T00:00:00Z' });
  assert.ok(early.every((r) => r.ts <= '2026-06-30T00:00:00Z'));
  assert.ok(early.length >= 1);
  db.close();
});

test('tool filter matches tool_names', () => {
  const db = seed();
  const bashOnly = search(db, { query: 'stripe', source: 'session', tool: 'Bash' });
  assert.ok(bashOnly.length >= 1);
  assert.ok(bashOnly.every((r) => (r.tools || '').includes('Bash')));
  db.close();
});

test('getSession returns ordered turns; getTurn returns neighbours', () => {
  const db = seed();
  const s = getSession(db, 's1');
  assert.strictEqual(s.session.session_id, 's1');
  assert.deepStrictEqual(s.turns.map((t) => t.uuid), ['u1', 'u2']);

  const ctx = getTurn(db, 'u2', 3);
  assert.strictEqual(ctx.focusUuid, 'u2');
  assert.ok(ctx.turns.some((t) => t.uuid === 'u1'));
  assert.strictEqual(getTurn(db, 'nope'), null);
  db.close();
});
