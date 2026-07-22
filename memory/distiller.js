'use strict';

// The distiller condenses a session into ONE narrative "session note" and stores it on
// the session row (`sessions.summary`). That note is surfaced as a searchable source in
// the Memory overlay (source: 'summary'), keeping recall — not injection — as its job.
//
// It deliberately does NOT touch Claude Code's native memory files
// (~/.claude/projects/<slug>/memory/*.md): native auto-memory solely owns durable,
// injected facts. Repointing here removed the two-writers collision on those files.
//
// SAFETY:
//  - The LLM call runs with GANGLION_TAB_ID unset + GANGLION_DISTILL=1 so it cannot
//    re-trigger ingestion of its own transcript (recursion guard).
//  - Live distillation is opt-in (GANGLION_DISTILL_ENABLED=1); the pure logic here is
//    always safe to unit-test with an injected runLLM.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CONTEXT_TURN_LIMIT = 40;
const PER_TURN_CHARS = 800;
const CONTEXT_TOTAL_CHARS = 12000;
const MAX_NOTE_CHARS = 4000;
const DISTILL_CWD = path.join(os.homedir(), '.ganglion', 'distill');

// --- Context + prompt --------------------------------------------------------------
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

function buildNotePrompt(contextText) {
  return `You are writing a concise session note for a developer's searchable memory log.
Read the recent session excerpt and write a single narrative note (roughly 120-250 words) that captures:
- what was worked on,
- key decisions or conclusions reached,
- the current state, and where things left off / any next steps.

Write plain prose or light markdown. Do NOT add a preamble, a heading like "Session Note:", or code fences — output only the note text itself. If the excerpt has no substantive work worth noting, respond with exactly: (no note)

RECENT SESSION EXCERPT:
${contextText}`;
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
 * Distill one session into a narrative note stored in `sessions.summary`.
 * The UPDATE fires the sessions_au trigger, so the sessions_fts index updates
 * automatically — no explicit FTS write here.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @param {{runLLM?:Function}} [opts] runLLM is injectable for tests.
 * @returns {Promise<{updated:boolean, chars?:number}>}
 */
async function distillSession(db, sessionId, opts = {}) {
  const runLLM = opts.runLLM || realRunLLM;
  const session = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) return { updated: false };

  const context = buildContext(db, sessionId);
  if (!context.trim()) return { updated: false };

  const raw = String((await runLLM(buildNotePrompt(context))) || '').trim();
  // Treat empty output or the explicit "no note" sentinel as nothing to record.
  if (!raw || /^\(no note\)$/i.test(raw)) return { updated: false };
  const note = raw.slice(0, MAX_NOTE_CHARS);

  db.prepare("UPDATE sessions SET summary = ?, updated_at = datetime('now') WHERE session_id = ?")
    .run(note, sessionId);
  return { updated: true, chars: note.length };
}

module.exports = {
  distillSession,
  buildContext,
  buildNotePrompt,
  realRunLLM
};
