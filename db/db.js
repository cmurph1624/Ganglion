'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DIR = path.join(os.homedir(), '.ganglion');
const DEFAULT_DB_PATH = path.join(DEFAULT_DIR, 'memory.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Open (or create) a memory database and apply the schema idempotently.
 * @param {string} [dbPath] path to the sqlite file, or ':memory:' for tests.
 * @returns {import('better-sqlite3').Database}
 */
function openDb(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  addMissingColumns(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS never alters an existing table, so columns added to
// schema.sql after a DB was created are added here. Add-only and nullable: an older
// server version reading the same file just ignores them.
const ADDED_COLUMNS = [['sessions', 'distilled_turns', 'INTEGER']];

function addMissingColumns(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// Lazily-opened process-wide singleton for the server.
let singleton = null;
function getDb() {
  if (!singleton) singleton = openDb();
  return singleton;
}

module.exports = { openDb, getDb, DEFAULT_DB_PATH, DEFAULT_DIR };
