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
  status          TEXT,                   -- last known: idle|working|waiting|error|completed
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

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

-- Distilled durable facts (projection lives in ~/.claude/projects/<slug>/memory/*.md).
CREATE TABLE IF NOT EXISTS memory_facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL,        -- filename stem, unique per project
  project_slug      TEXT NOT NULL,
  name              TEXT,                 -- frontmatter name/title
  description       TEXT,                 -- one-line index desc
  body              TEXT,                 -- markdown body
  fact_type         TEXT,                 -- user|feedback|project|reference
  origin_session_id TEXT,                 -- citation back to source session
  char_count        INTEGER,
  authored_by       TEXT DEFAULT 'ganglion', -- 'ganglion' | 'user' (never auto-overwrite 'user')
  file_path         TEXT,                 -- the ~/.claude/.../memory/<slug>.md it maintains
  active            INTEGER DEFAULT 1,    -- 0 = demoted out of the injected index
  embedding         BLOB,                 -- semantic-ready, NULL now
  embedding_model   TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT,
  UNIQUE(project_slug, slug)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
  name, description, body,
  content='memory_facts', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(rowid, name, description, body)
    VALUES (new.id, new.name, new.description, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, name, description, body)
    VALUES ('delete', old.id, old.name, old.description, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, name, description, body)
    VALUES ('delete', old.id, old.name, old.description, old.body);
  INSERT INTO memory_facts_fts(rowid, name, description, body)
    VALUES (new.id, new.name, new.description, new.body);
END;

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
