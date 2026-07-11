'use strict';

const fs = require('fs');
const path = require('path');

const NEWLINE = 0x0a;

/** Derive the project slug (dir name) from a transcript path. */
function projectSlugFor(transcriptPath) {
  return path.basename(path.dirname(transcriptPath));
}

/**
 * Flatten a message's content into plain searchable text.
 * String content passes through; array content concatenates text + thinking blocks.
 * Raw tool_result output is intentionally excluded from FTS text (can be huge/noisy);
 * the byte_offset lets callers re-read the full raw line when they need it.
 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
  }
  return parts.join('\n');
}

/** Collect comma-joined tool_use names from array content. */
function toolNamesFrom(content) {
  if (!Array.isArray(content)) return '';
  const names = [];
  for (const block of content) {
    if (block && block.type === 'tool_use' && block.name) names.push(block.name);
  }
  return names.join(',');
}

/** True if any tool_result block in the content is an error. */
function hasErrorIn(content) {
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && b.type === 'tool_result' && b.is_error === true);
}

/**
 * Incrementally ingest new lines from a Claude Code transcript JSONL into the DB.
 * Reads only bytes appended since the session's `ingested_bytes`, never advancing
 * past a partial trailing line. Idempotent: turns are de-duped on their JSONL uuid.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} transcriptPath absolute path to the *.jsonl file
 * @returns {{sessionId: string|null, added: number, offset: number}}
 */
function ingestTranscript(db, transcriptPath) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { sessionId: null, added: 0, offset: 0 };
  }
  const size = stat.size;

  const slug = projectSlugFor(transcriptPath);
  // session_id is derived from the transcript; before we've parsed a line we key
  // the read offset on the transcript_path so re-runs resume correctly.
  const existing = db
    .prepare('SELECT session_id, ingested_bytes FROM sessions WHERE transcript_path = ?')
    .get(transcriptPath);
  let startOffset = existing ? existing.ingested_bytes : 0;
  if (size <= startOffset) {
    return { sessionId: existing ? existing.session_id : null, added: 0, offset: startOffset };
  }

  // Read only the appended slice.
  const fd = fs.openSync(transcriptPath, 'r');
  const len = size - startOffset;
  const buf = Buffer.allocUnsafe(len);
  fs.readSync(fd, buf, 0, len, startOffset);
  fs.closeSync(fd);

  // Split into complete lines; keep a trailing partial line unconsumed.
  const lines = [];
  let lineStart = 0; // byte offset within buf where the current line begins
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NEWLINE) {
      lines.push({ absStart: startOffset + lineStart, bytes: buf.subarray(lineStart, i) });
      lineStart = i + 1;
    }
  }
  // Everything up to lineStart is consumed; a non-empty remainder is a partial line.
  const newOffset = startOffset + lineStart;

  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, project_slug, project_path, transcript_path, git_branch, started_at, ended_at, turn_count, ingested_bytes, status, updated_at)
     VALUES (@session_id, @project_slug, @project_path, @transcript_path, @git_branch, @ts, @ts, 0, @offset, @status, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       ended_at = excluded.ended_at,
       ingested_bytes = excluded.ingested_bytes,
       project_path = COALESCE(excluded.project_path, sessions.project_path),
       git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
       status = COALESCE(excluded.status, sessions.status),
       updated_at = datetime('now')`
  );
  const insertTurn = db.prepare(
    `INSERT OR IGNORE INTO turns (uuid, session_id, parent_uuid, role, ts, model, text, tool_names, has_error, byte_offset)
     VALUES (@uuid, @session_id, @parent_uuid, @role, @ts, @model, @text, @tool_names, @has_error, @byte_offset)`
  );
  const bumpCount = db.prepare(
    `UPDATE sessions SET turn_count = (SELECT count(*) FROM turns WHERE session_id = ?) WHERE session_id = ?`
  );

  const startedAtFix = db.prepare(
    `UPDATE sessions SET started_at = MIN(started_at, ?) WHERE session_id = ?`
  );
  const advanceOffsetByPath = db.prepare(
    `UPDATE sessions SET ingested_bytes = ? WHERE transcript_path = ?`
  );

  let sessionId = existing ? existing.session_id : null;
  let added = 0;

  const run = db.transaction(() => {
    // Pass 1: parse the appended lines, keeping only user/assistant turns.
    const parsedTurns = [];
    let firstTs = null;
    let lastTs = null;
    let projectPath = null;
    let gitBranch = null;
    for (const { absStart, bytes } of lines) {
      const raw = bytes.toString('utf8');
      if (!raw.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      if (!obj.uuid || !obj.sessionId) continue;

      sessionId = obj.sessionId;
      const ts = obj.timestamp || null;
      if (!firstTs) firstTs = ts;
      if (ts) lastTs = ts;
      if (obj.cwd) projectPath = obj.cwd;
      if (obj.gitBranch) gitBranch = obj.gitBranch;
      parsedTurns.push({ obj, absStart });
    }

    // Upsert the session row FIRST so the turns' foreign key is satisfied.
    if (sessionId) {
      insertSession.run({
        session_id: sessionId,
        project_slug: slug,
        project_path: projectPath,
        transcript_path: transcriptPath,
        git_branch: gitBranch,
        ts: lastTs,
        offset: newOffset,
        status: null
      });
      if (firstTs) startedAtFix.run(firstTs, sessionId);
    } else {
      // No parseable turns yet; still advance the offset so we don't re-scan noise.
      advanceOffsetByPath.run(newOffset, transcriptPath);
    }

    // Pass 2: insert the turns.
    for (const { obj, absStart } of parsedTurns) {
      const msg = obj.message || {};
      const res = insertTurn.run({
        uuid: obj.uuid,
        session_id: obj.sessionId,
        parent_uuid: obj.parentUuid || null,
        role: obj.type,
        ts: obj.timestamp || null,
        model: msg.model || null,
        text: flattenContent(msg.content),
        tool_names: toolNamesFrom(msg.content) || null,
        has_error: hasErrorIn(msg.content) ? 1 : 0,
        byte_offset: absStart
      });
      added += res.changes;
    }

    if (sessionId) bumpCount.run(sessionId, sessionId);
  });
  run();

  return { sessionId, added, offset: newOffset };
}

module.exports = { ingestTranscript, flattenContent, toolNamesFrom, hasErrorIn, projectSlugFor };
