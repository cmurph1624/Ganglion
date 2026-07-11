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
  return db;
}

// Lazily-opened process-wide singleton for the server.
let singleton = null;
function getDb() {
  if (!singleton) singleton = openDb();
  return singleton;
}

module.exports = { openDb, getDb, DEFAULT_DB_PATH, DEFAULT_DIR };
