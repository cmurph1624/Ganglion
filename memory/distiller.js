'use strict';

// The distiller consolidates durable facts out of a session and maintains the native
// Claude Code memory files (~/.claude/projects/<slug>/memory/*.md + MEMORY.md) that
// get injected at session start. It is the "storage + injection" half of the system.
//
// SAFETY (see plan risks):
//  - It only ever writes files it authored (stamped `metadata.authoredBy: ganglion`).
//    Any pre-existing file without that marker is treated as user-owned and read-only:
//    it is mirrored into the DB so the index preserves it, but its .md is never
//    rewritten or deleted.
//  - Every write is preceded by a timestamped backup of the whole memory dir.
//  - The LLM call runs with GANGLION_TAB_ID unset + GANGLION_DISTILL=1 so it cannot
//    re-trigger ingestion of its own transcript (recursion guard).
//  - Live distillation is opt-in (GANGLION_DISTILL_ENABLED=1); the pure logic here is
//    always safe to unit-test with an injected runLLM.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAX_FACT_CHARS = 2500;
const MAX_INDEX_ENTRIES = 40;
const CONTEXT_TURN_LIMIT = 40;
const PER_TURN_CHARS = 800;
const CONTEXT_TOTAL_CHARS = 12000;
// Base dirs are overridable via env so tests never touch real memory/backups.
function projectsBase() {
  return process.env.GANGLION_MEMORY_BASE || path.join(os.homedir(), '.claude', 'projects');
}
function backupRoot() {
  return process.env.GANGLION_BACKUP_ROOT || path.join(os.homedir(), '.ganglion', 'memory-backups');
}
const DISTILL_CWD = path.join(os.homedir(), '.ganglion', 'distill');

function memDirFor(projectSlug) {
  return path.join(projectsBase(), projectSlug, 'memory');
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'fact';
}

// --- Frontmatter (minimal, matches Claude Code's native fact-file format) ----------
function parseFactFile(text) {
  const out = { name: null, description: null, type: null, authoredBy: null, originSessionId: null, body: text };
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return out;
  const fm = text.slice(3, end);
  out.body = text.slice(text.indexOf('\n', end + 1) + 1).replace(/^\n+/, '');
  const grab = (re) => { const m = fm.match(re); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; };
  out.name = grab(/\n?\s*name:\s*(.+)/);
  out.description = grab(/\n?\s*description:\s*(.+)/);
  out.type = grab(/\n\s*type:\s*(.+)/);
  out.authoredBy = grab(/\n\s*authoredBy:\s*(.+)/);
  out.originSessionId = grab(/\n\s*originSessionId:\s*(.+)/);
  return out;
}

function renderFactFile(fact) {
  const desc = (fact.description || '').replace(/"/g, "'");
  return `---
name: ${fact.slug}
description: "${desc}"
metadata:
  node_type: memory
  type: ${fact.fact_type || 'reference'}
  authoredBy: ganglion
  originSessionId: ${fact.origin_session_id || ''}
---

${(fact.body || '').trim()}
`;
}

function renderMemoryIndex(facts) {
  const lines = ['# Memory Index', ''];
  for (const f of facts) {
    const title = f.name || f.slug;
    lines.push(`- [${title}](${f.slug}.md) — ${f.description || ''}`);
  }
  return lines.join('\n') + '\n';
}

// --- Mirror pre-existing native memory files into the DB (so the index preserves them)
function syncExistingMemoryFiles(db, projectSlug) {
  const dir = memDirFor(projectSlug);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    return;
  }
  const upsert = db.prepare(
    `INSERT INTO memory_facts (slug, project_slug, name, description, body, fact_type, origin_session_id, char_count, authored_by, file_path, updated_at)
     VALUES (@slug, @project_slug, @name, @description, @body, @fact_type, @origin_session_id, @char_count, @authored_by, @file_path, datetime('now'))
     ON CONFLICT(project_slug, slug) DO UPDATE SET
       description = excluded.description, body = excluded.body, fact_type = excluded.fact_type,
       authored_by = excluded.authored_by, file_path = excluded.file_path, updated_at = datetime('now')`
  );
  for (const f of files) {
    const abs = path.join(dir, f);
    const parsed = parseFactFile(fs.readFileSync(abs, 'utf8'));
    const slug = parsed.name || path.basename(f, '.md');
    upsert.run({
      slug,
      project_slug: projectSlug,
      name: null,
      description: parsed.description,
      body: parsed.body,
      fact_type: parsed.type || 'reference',
      origin_session_id: parsed.originSessionId,
      char_count: (parsed.body || '').length,
      authored_by: parsed.authoredBy === 'ganglion' ? 'ganglion' : 'user',
      file_path: abs
    });
  }
}

// --- LLM prompt/response -----------------------------------------------------------
function buildContext(db, sessionId) {
  const turns = db
    .prepare("SELECT role, text FROM turns WHERE session_id = ? AND text != '' ORDER BY id DESC LIMIT ?")
    .all(sessionId, CONTEXT_TURN_LIMIT)
    .reverse();
  let total = 0;
  const parts = [];
  for (const t of turns) {
    const snippet = (t.text || '').slice(0, PER_TURN_CHARS);
    if (total + snippet.length > CONTEXT_TOTAL_CHARS) break;
    total += snippet.length;
    parts.push(`${t.role.toUpperCase()}: ${snippet}`);
  }
  return parts.join('\n\n');
}

function buildPrompt(contextText, existingFacts) {
  const existing = existingFacts.length
    ? existingFacts.map((f) => `- ${f.slug}: ${f.description || ''}`).join('\n')
    : '(none yet)';
  return `You maintain a durable memory for a developer named Chris. Read the recent session excerpt and decide what — if anything — is worth remembering long-term.

Only record DURABLE, REUSABLE facts: decisions, preferences, conventions, environment quirks, credentials locations, gotchas. Do NOT record transient task state, one-off debugging, or anything already covered by an existing fact.

EXISTING FACTS (dedup against these; use action "update" with the same slug to revise one):
${existing}

RECENT SESSION EXCERPT:
${contextText}

Respond with ONLY a JSON object, no prose:
{"facts":[{"action":"create|update|skip","slug":"kebab-case-id","title":"Short Human Title","description":"one-line hook under 120 chars","type":"user|feedback|project|reference","body":"markdown, under ${MAX_FACT_CHARS} chars"}]}
If nothing is worth saving, return {"facts":[]}.`;
}

// Scan from the first '{' to its matching '}', respecting string literals, so trailing
// prose after the JSON object can't break parsing.
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLLMFacts(text) {
  if (!text) return [];
  // Prefer a fenced ```json block if the model wrapped its answer.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : null) || extractJsonObject(text);
  if (!candidate) return [];
  let obj;
  try {
    obj = JSON.parse(candidate.trim());
  } catch {
    // Fall back to a balanced scan of the raw text.
    const alt = extractJsonObject(text);
    if (!alt) return [];
    try { obj = JSON.parse(alt); } catch { return []; }
  }
  if (!obj || !Array.isArray(obj.facts)) return [];
  return obj.facts;
}

// --- Apply facts + write back ------------------------------------------------------
function applyFacts(db, projectSlug, sessionId, facts) {
  const dir = memDirFor(projectSlug);
  let applied = 0;
  const getExisting = db.prepare('SELECT authored_by FROM memory_facts WHERE project_slug = ? AND slug = ?');
  const upsert = db.prepare(
    `INSERT INTO memory_facts (slug, project_slug, name, description, body, fact_type, origin_session_id, char_count, authored_by, file_path, active, updated_at)
     VALUES (@slug, @project_slug, @name, @description, @body, @fact_type, @origin_session_id, @char_count, 'ganglion', @file_path, 1, datetime('now'))
     ON CONFLICT(project_slug, slug) DO UPDATE SET
       name = excluded.name, description = excluded.description, body = excluded.body,
       fact_type = excluded.fact_type, origin_session_id = excluded.origin_session_id,
       char_count = excluded.char_count, active = 1, updated_at = datetime('now')`
  );
  for (const f of facts) {
    if (!f || f.action === 'skip') continue;
    const slug = slugify(f.slug || f.title);
    const existing = getExisting.get(projectSlug, slug);
    // Never overwrite a user-authored fact.
    if (existing && existing.authored_by === 'user') continue;
    const body = String(f.body || '').slice(0, MAX_FACT_CHARS);
    upsert.run({
      slug,
      project_slug: projectSlug,
      name: f.title || slug,
      description: String(f.description || '').slice(0, 200),
      body,
      fact_type: ['user', 'feedback', 'project', 'reference'].includes(f.type) ? f.type : 'reference',
      origin_session_id: sessionId,
      char_count: body.length,
      file_path: path.join(dir, `${slug}.md`)
    });
    applied++;
  }
  return applied;
}

function backupMemoryDir(projectSlug, now) {
  const dir = memDirFor(projectSlug);
  if (!fs.existsSync(dir)) return null;
  const stamp = (now || new Date()).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot(), projectSlug, stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(dir, f), path.join(dest, f));
  }
  return dest;
}

// Enforce the index size cap by demoting the least-recently-updated ganglion facts.
function enforceIndexCap(db, projectSlug) {
  const active = db
    .prepare("SELECT slug, authored_by FROM memory_facts WHERE project_slug = ? AND active = 1 ORDER BY updated_at DESC")
    .all(projectSlug);
  if (active.length <= MAX_INDEX_ENTRIES) return;
  const demote = db.prepare('UPDATE memory_facts SET active = 0 WHERE project_slug = ? AND slug = ?');
  let kept = 0;
  for (const f of active) {
    kept++;
    if (kept > MAX_INDEX_ENTRIES && f.authored_by === 'ganglion') demote.run(projectSlug, f.slug);
  }
}

function writeBack(db, projectSlug, now) {
  const dir = memDirFor(projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  backupMemoryDir(projectSlug, now);
  enforceIndexCap(db, projectSlug);

  // Write only ganglion-authored fact files (user files are left untouched on disk).
  const ganglionFacts = db
    .prepare("SELECT * FROM memory_facts WHERE project_slug = ? AND authored_by = 'ganglion' AND active = 1")
    .all(projectSlug);
  for (const f of ganglionFacts) {
    fs.writeFileSync(path.join(dir, `${f.slug}.md`), renderFactFile(f));
  }

  // Regenerate MEMORY.md from ALL active facts (user + ganglion), preserving user entries.
  const indexFacts = db
    .prepare("SELECT slug, name, description FROM memory_facts WHERE project_slug = ? AND active = 1 ORDER BY updated_at DESC")
    .all(projectSlug);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), renderMemoryIndex(indexFacts));
  return { files: ganglionFacts.length, indexEntries: indexFacts.length };
}

// --- Real LLM runner (headless claude -p, recursion-guarded) -----------------------
function realRunLLM(prompt) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(DISTILL_CWD, { recursive: true });
    const model = process.env.GANGLION_DISTILL_MODEL || 'haiku';
    const env = { ...process.env, GANGLION_DISTILL: '1' };
    delete env.GANGLION_TAB_ID; // recursion guard: no ingest signal from this subprocess
    execFile(
      path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
      ['-p', prompt, '--model', model, '--output-format', 'text'],
      { cwd: DISTILL_CWD, env, timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      }
    );
  });
}

/**
 * Distill one session into durable facts and rewrite its project's memory files.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @param {{runLLM?:Function, now?:Date}} [opts] runLLM is injectable for tests.
 * @returns {Promise<{applied:number, files:number, indexEntries:number}>}
 */
async function distillSession(db, sessionId, opts = {}) {
  const runLLM = opts.runLLM || realRunLLM;
  const session = db.prepare('SELECT project_slug FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) return { applied: 0, files: 0, indexEntries: 0 };
  const projectSlug = session.project_slug;

  syncExistingMemoryFiles(db, projectSlug);
  const context = buildContext(db, sessionId);
  if (!context.trim()) return { applied: 0, files: 0, indexEntries: 0 };

  const existingFacts = db
    .prepare('SELECT slug, description FROM memory_facts WHERE project_slug = ?')
    .all(projectSlug);

  const raw = await runLLM(buildPrompt(context, existingFacts));
  const facts = parseLLMFacts(raw);
  const applied = applyFacts(db, projectSlug, sessionId, facts);
  if (applied === 0) return { applied: 0, files: 0, indexEntries: 0 };
  const wb = writeBack(db, projectSlug, opts.now);
  return { applied, ...wb };
}

module.exports = {
  distillSession,
  syncExistingMemoryFiles,
  buildPrompt,
  buildContext,
  parseLLMFacts,
  applyFacts,
  writeBack,
  renderFactFile,
  renderMemoryIndex,
  parseFactFile,
  slugify,
  memDirFor,
  realRunLLM
};
