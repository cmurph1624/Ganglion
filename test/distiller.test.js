'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../db/db');

// Point the distiller's memory + backup dirs at throwaway temp locations.
const MEM_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ganglion-mem-'));
const BK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ganglion-bk-'));
process.env.GANGLION_MEMORY_BASE = MEM_BASE;
process.env.GANGLION_BACKUP_ROOT = BK_ROOT;

const distiller = require('../memory/distiller');
const { distillSession, parseLLMFacts, slugify, memDirFor, renderMemoryIndex } = distiller;

function seedSession(db, sessionId = 's1', slug = 'proj-x') {
  db.prepare('INSERT INTO sessions(session_id, project_slug, transcript_path) VALUES(?,?,?)').run(sessionId, slug, '/t.jsonl');
  const t = db.prepare('INSERT INTO turns(uuid, session_id, role, text) VALUES(?,?,?,?)');
  t.run('u1', sessionId, 'user', 'Always deploy the pain diary via EAS, never expo publish.');
  t.run('u2', sessionId, 'assistant', 'Understood — using eas build/submit for the Pain Diary app.');
  return slug;
}

const fakeLLM = (facts) => async () => JSON.stringify({ facts });

test('parseLLMFacts tolerates prose around the JSON and bad input', () => {
  assert.deepStrictEqual(parseLLMFacts('here you go: {"facts":[{"action":"skip"}]} done').length, 1);
  assert.deepStrictEqual(parseLLMFacts('no json here'), []);
  assert.deepStrictEqual(parseLLMFacts('{"nope":1}'), []);
});

test('parseLLMFacts handles fenced blocks and trailing prose with braces', () => {
  const fenced = '```json\n{"facts":[{"action":"create","slug":"a"}]}\n```\n\nNote: nothing {else} needed.';
  assert.strictEqual(parseLLMFacts(fenced).length, 1);
  // Trailing prose containing braces must not break the balanced scan.
  const trailing = '{"facts":[]}\n\nThis is already in {CLAUDE.md} so no entry.';
  assert.deepStrictEqual(parseLLMFacts(trailing), []);
  // A body value containing braces stays intact.
  const withBraces = '{"facts":[{"action":"create","slug":"x","body":"use {curly} here"}]}';
  assert.strictEqual(parseLLMFacts(withBraces)[0].body, 'use {curly} here');
});

test('slugify produces safe kebab ids', () => {
  assert.strictEqual(slugify('EAS Deploy Rule!'), 'eas-deploy-rule');
  assert.strictEqual(slugify(''), 'fact');
});

test('distillSession writes a ganglion fact file + MEMORY.md and backs up', async () => {
  const db = openDb(':memory:');
  const slug = seedSession(db);
  const res = await distillSession(db, 's1', {
    now: new Date('2026-07-10T12:00:00Z'),
    runLLM: fakeLLM([
      { action: 'create', slug: 'eas-deploy', title: 'EAS Deploy Rule', description: 'Deploy Pain Diary via EAS', type: 'feedback', body: 'Use eas build/submit; never expo publish.' }
    ])
  });
  assert.strictEqual(res.applied, 1);

  const dir = memDirFor(slug);
  const factFile = fs.readFileSync(path.join(dir, 'eas-deploy.md'), 'utf8');
  assert.match(factFile, /authoredBy: ganglion/);
  assert.match(factFile, /type: feedback/);
  assert.match(factFile, /never expo publish/);

  const index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.match(index, /\[EAS Deploy Rule\]\(eas-deploy\.md\)/);

  // A backup dir was created.
  assert.ok(fs.existsSync(path.join(BK_ROOT, slug)));
  db.close();
});

test('NEVER overwrites a user-authored memory file', async () => {
  const db = openDb(':memory:');
  const slug = seedSession(db, 's2', 'proj-user');
  const dir = memDirFor(slug);
  fs.mkdirSync(dir, { recursive: true });
  // A pre-existing native (user) fact WITHOUT the ganglion marker.
  const userFile = path.join(dir, 'sacred.md');
  const userContent = `---
name: sacred
description: "hand-written, do not touch"
metadata:
  node_type: memory
  type: reference
---

Precious user knowledge.`;
  fs.writeFileSync(userFile, userContent);

  // LLM tries to overwrite the same slug — must be refused.
  const res = await distillSession(db, 's2', {
    now: new Date('2026-07-10T12:00:00Z'),
    runLLM: fakeLLM([
      { action: 'update', slug: 'sacred', title: 'Hijacked', description: 'evil', type: 'reference', body: 'OVERWRITTEN' }
    ])
  });

  // The user's file content is untouched on disk, and nothing was applied.
  assert.strictEqual(fs.readFileSync(userFile, 'utf8'), userContent);
  assert.strictEqual(res.applied, 0);
  db.close();
});

test('preserves user entries alongside new ganglion facts in the index', async () => {
  const db = openDb(':memory:');
  const slug = seedSession(db, 's3', 'proj-mix');
  const dir = memDirFor(slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-note.md'),
    '---\nname: user-note\ndescription: "a user note"\nmetadata:\n  type: reference\n---\n\nbody'
  );

  await distillSession(db, 's3', {
    runLLM: fakeLLM([
      { action: 'create', slug: 'new-fact', title: 'New Fact', description: 'from session', type: 'project', body: 'content' }
    ])
  });
  const index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.match(index, /\(user-note\.md\)/);
  assert.match(index, /\(new-fact\.md\)/);
  db.close();
});

test('enforces the per-fact character cap', async () => {
  const db = openDb(':memory:');
  const slug = seedSession(db, 's4', 'proj-cap');
  const big = 'x'.repeat(5000);
  await distillSession(db, 's4', {
    runLLM: fakeLLM([{ action: 'create', slug: 'big', title: 'Big', description: 'd', type: 'reference', body: big }])
  });
  const row = db.prepare("SELECT char_count FROM memory_facts WHERE slug='big'").get();
  assert.ok(row.char_count <= 2500, `expected <=2500, got ${row.char_count}`);
  db.close();
});

test('renderMemoryIndex formats native-style entries', () => {
  const out = renderMemoryIndex([{ slug: 'a', name: 'Alpha', description: 'first' }]);
  assert.match(out, /# Memory Index/);
  assert.match(out, /- \[Alpha\]\(a\.md\) — first/);
});
