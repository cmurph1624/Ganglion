'use strict';

// Recall over the memory store. Structured as two stages so a vector retriever +
// reranker can be added later without changing the callers:
//   retrieve(db, opts) -> candidate rows (today: FTS5 keyword over turns + notes)
//   rank(candidates)   -> ordered results (today: bm25 ascending)
// search() composes them and is what the server calls.

/**
 * Turn free text into a safe FTS5 MATCH expression. User input may contain FTS
 * operators/punctuation that would throw; we extract word tokens and phrase-quote
 * each so they are ANDed literally.
 */
function buildFtsQuery(query) {
  const tokens = (query || '').match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.map((t) => `"${t}"`).join(' ');
}

function retrieveSessions(db, fts, opts, limit) {
  let sql = `
    SELECT t.uuid AS id, t.session_id AS sessionId, s.project_slug AS project,
           s.transcript_path AS path, t.ts AS ts, t.role AS role,
           t.tool_names AS tools, t.byte_offset AS byteOffset,
           bm25(turns_fts) AS score,
           snippet(turns_fts, 0, '[[', ']]', '…', 12) AS snippet
    FROM turns_fts
    JOIN turns t ON t.id = turns_fts.rowid
    JOIN sessions s ON s.session_id = t.session_id
    WHERE turns_fts MATCH @fts`;
  const params = { fts, limit };
  if (opts.project) { sql += ' AND s.project_slug = @project'; params.project = opts.project; }
  if (opts.dateFrom) { sql += ' AND t.ts >= @dateFrom'; params.dateFrom = opts.dateFrom; }
  if (opts.dateTo) { sql += ' AND t.ts <= @dateTo'; params.dateTo = opts.dateTo; }
  if (opts.tool) { sql += ' AND t.tool_names LIKE @tool'; params.tool = `%${opts.tool}%`; }
  if (opts.status) { sql += ' AND s.status = @status'; params.status = opts.status; }
  sql += ' ORDER BY score LIMIT @limit';
  return db.prepare(sql).all(params).map((r) => ({
    source: 'session',
    id: r.id,
    title: null,
    project: r.project,
    path: r.path,
    sessionId: r.sessionId,
    ts: r.ts,
    role: r.role,
    tools: r.tools,
    byteOffset: r.byteOffset,
    snippet: r.snippet,
    score: r.score
  }));
}

function retrieveNotes(db, fts, opts, limit) {
  let sql = `
    SELECT d.id AS id, d.title AS title, d.folder AS folder, d.path AS path,
           d.mtime AS mtime, bm25(documents_fts) AS score,
           snippet(documents_fts, 1, '[[', ']]', '…', 12) AS snippet
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH @fts`;
  const params = { fts, limit };
  // Notes can be scoped by folder via the same `project` filter (prefix match).
  if (opts.project) { sql += ' AND d.folder LIKE @folder'; params.folder = `${opts.project}%`; }
  sql += ' ORDER BY score LIMIT @limit';
  return db.prepare(sql).all(params).map((r) => ({
    source: 'note',
    id: String(r.id),
    title: r.title,
    project: r.folder,
    path: r.path,
    sessionId: null,
    ts: r.mtime ? new Date(r.mtime).toISOString() : null,
    role: null,
    tools: null,
    byteOffset: null,
    snippet: r.snippet,
    score: r.score
  }));
}

function retrieveSummaries(db, fts, opts, limit) {
  let sql = `
    SELECT s.session_id AS sessionId, s.project_slug AS project,
           s.transcript_path AS path, s.ended_at AS ts, s.status AS status,
           bm25(sessions_fts) AS score,
           snippet(sessions_fts, 0, '[[', ']]', '…', 12) AS snippet
    FROM sessions_fts
    JOIN sessions s ON s.rowid = sessions_fts.rowid
    WHERE sessions_fts MATCH @fts`;
  const params = { fts, limit };
  if (opts.project) { sql += ' AND s.project_slug = @project'; params.project = opts.project; }
  if (opts.dateFrom) { sql += ' AND s.ended_at >= @dateFrom'; params.dateFrom = opts.dateFrom; }
  if (opts.dateTo) { sql += ' AND s.ended_at <= @dateTo'; params.dateTo = opts.dateTo; }
  if (opts.status) { sql += ' AND s.status = @status'; params.status = opts.status; }
  sql += ' ORDER BY score LIMIT @limit';
  return db.prepare(sql).all(params).map((r) => ({
    source: 'summary',
    id: r.sessionId, // session_id doubles as the id for context expansion
    title: null,
    project: r.project,
    path: r.path,
    sessionId: r.sessionId,
    ts: r.ts,
    role: null,
    tools: null,
    byteOffset: null,
    snippet: r.snippet,
    score: r.score
  }));
}

/** Stage 1: gather candidates from the requested source(s). */
function retrieve(db, opts = {}) {
  const fts = buildFtsQuery(opts.query);
  if (!fts) return [];
  const source = opts.source || 'all';
  const perSource = opts.limit || 30;
  const out = [];
  if (source === 'all' || source === 'session') out.push(...retrieveSessions(db, fts, opts, perSource));
  if (source === 'all' || source === 'summary') out.push(...retrieveSummaries(db, fts, opts, perSource));
  if (source === 'all' || source === 'note') out.push(...retrieveNotes(db, fts, opts, perSource));
  return out;
}

/** Stage 2: order candidates. bm25 is negative; lower is more relevant. */
function rank(candidates, limit = 30) {
  return candidates.slice().sort((a, b) => a.score - b.score).slice(0, limit);
}

function search(db, opts = {}) {
  return rank(retrieve(db, opts), opts.limit || 30);
}

/** Full session with its ordered turns — for context expansion / citation. */
function getSession(db, sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) return null;
  const turns = db
    .prepare('SELECT uuid, parent_uuid, role, ts, model, text, tool_names, has_error FROM turns WHERE session_id = ? ORDER BY id')
    .all(sessionId);
  return { session, turns };
}

/** A turn plus its immediate neighbours in the same session (context expand). */
function getTurn(db, uuid, context = 3) {
  const turn = db.prepare('SELECT id, session_id FROM turns WHERE uuid = ?').get(uuid);
  if (!turn) return null;
  const neighbours = db
    .prepare(
      `SELECT uuid, role, ts, model, text, tool_names, has_error
       FROM turns
       WHERE session_id = @sid AND id BETWEEN @lo AND @hi
       ORDER BY id`
    )
    .all({ sid: turn.session_id, lo: turn.id - context, hi: turn.id + context });
  return { sessionId: turn.session_id, focusUuid: uuid, turns: neighbours };
}

module.exports = { search, retrieve, rank, getSession, getTurn, buildFtsQuery, retrieveSummaries };
