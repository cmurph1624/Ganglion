-- Ganglion memory store schema.
-- Applied idempotently on every boot by db/db.js. Safe to re-run.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per Claude Code session (a transcript JSONL file).
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,       -- JSONL sessionId
  project_slug    TEXT NOT NULL,          -- ~/.claude/projects/<slug>
  project_path    TEXT,                   -- real cwd (unslugged)
  transcript_path TEXT NOT NULL,
  git_branch      TEXT,
  started_at      TEXT,                   -- ISO ts of first turn
  ended_at        TEXT,                   -- ISO ts of last turn
  turn_count      INTEGER DEFAULT 0,
  ingested_bytes  INTEGER DEFAULT 0,      -- incremental read offset into the JSONL
  summary         TEXT,                   -- distilled per-session summary
  distilled_turns INTEGER,                -- turn_count the last distiller run covered (note or "(no note)")
  status          TEXT,                   -- last known: idle|working|waiting|error|completed
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

-- FTS5 over per-session distilled notes, keyed by sessions.rowid.
--
-- Unlike turns_fts/documents_fts (external-content, which avoid duplicating large text),
-- this is a STANDALONE FTS5 table. Two reasons: (1) summary is tiny, so a copy is cheap;
-- (2) crucially, this index is added to a DB that ALREADY has session rows, and external
-- content would corrupt (SQLITE_CORRUPT_VTAB) the first time a trigger tried to 'delete'
-- a pre-existing row that was never indexed. A standalone table lets the triggers use a
-- forgiving DELETE-then-INSERT (a no-op for not-yet-indexed rows), so the backfill's
-- `UPDATE sessions SET summary` cleanly indexes each old session on demand.
--
-- The update trigger is scoped `OF summary` so routine ingest — which UPDATEs sessions
-- often (ended_at, turn_count, …) but never touches summary — does NOT churn this index;
-- only the distiller's `UPDATE sessions SET summary` fires it. NULL summaries are never
-- indexed (ingest inserts sessions with a NULL summary; the note arrives later via UPDATE).
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  summary,
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions WHEN new.summary IS NOT NULL BEGIN
  INSERT INTO sessions_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
  DELETE FROM sessions_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE OF summary ON sessions BEGIN
  DELETE FROM sessions_fts WHERE rowid = new.rowid;
  INSERT INTO sessions_fts(rowid, summary) SELECT new.rowid, new.summary WHERE new.summary IS NOT NULL;
END;

-- One row per JSONL user/assistant line.
CREATE TABLE IF NOT EXISTS turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid            TEXT UNIQUE NOT NULL,   -- JSONL uuid; dedup key
  session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  parent_uuid     TEXT,                   -- reconstruct threads / context-expand
  role            TEXT NOT NULL,          -- user|assistant
  ts              TEXT,                   -- ISO timestamp
  model           TEXT,                   -- assistant model id
  text            TEXT,                   -- flattened text/thinking for FTS + snippet
  tool_names      TEXT,                   -- comma-joined tool_use names in this turn
  has_error       INTEGER DEFAULT 0,      -- any tool_result is_error
  byte_offset     INTEGER,                -- offset of this line in the transcript
  embedding       BLOB,                   -- NULL now; sqlite-vec vector later. NO REWRITE.
  embedding_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);

-- FTS5 keyword index over turn text (external-content, mirrors turns).
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  text,
  content='turns', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
END;

-- NOTE: the former `memory_facts` table + FTS mirror were retired when the distiller
-- was repointed to write per-session notes into `sessions.summary` (see memory/distiller.js).
-- Claude Code's native auto-memory now solely owns durable/injected facts. Fresh DBs no
-- longer create memory_facts; any pre-existing table is left frozen/orphaned (dropping it
-- from this always-applied schema would be destructive on every boot).

-- Indexed Obsidian vault notes (and any non-transcript source). Read-only mirror.
CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  path            TEXT UNIQUE NOT NULL,   -- absolute file path
  title           TEXT,                   -- frontmatter title or filename
  body            TEXT,                   -- note text (frontmatter stripped)
  folder          TEXT,                   -- PARA area, e.g. "10 Projects/Ganglion"
  tags            TEXT,                   -- comma-joined frontmatter tags
  mtime           INTEGER,                -- file mtimeMs; incremental reindex key
  embedding       BLOB,                   -- semantic-ready, NULL now
  embedding_model TEXT,
  indexed_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, body,
  content='documents', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
