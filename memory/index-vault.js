'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_VAULT = path.join(os.homedir(), 'TheBrainOfChris');

// The Obsidian vault to index: GANGLION_VAULT, else ~/TheBrainOfChris. One resolver for the
// server, the CLI and the import script, so they can't disagree about which vault it is.
function resolveVault(env = process.env) {
  return env.GANGLION_VAULT || DEFAULT_VAULT;
}
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

/**
 * Minimal YAML frontmatter parser — extracts `title` and `tags`, returns the body
 * with the frontmatter block stripped. Avoids a YAML dependency; handles the two
 * tag shapes used in the vault (block list and inline array).
 */
function parseNote(text) {
  let title = null;
  let tags = [];
  let body = text;

  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = text.slice(3, end).replace(/^\n/, '');
      body = text.slice(text.indexOf('\n', end + 1) + 1);
      const lines = fm.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const titleMatch = line.match(/^title:\s*(.+)$/);
        if (titleMatch) {
          title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
          continue;
        }
        const tagsInline = line.match(/^tags:\s*\[(.*)\]\s*$/);
        if (tagsInline) {
          tags = tagsInline[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
          continue;
        }
        if (/^tags:\s*$/.test(line)) {
          // block list: subsequent "  - tag" lines
          for (let j = i + 1; j < lines.length; j++) {
            const item = lines[j].match(/^\s*-\s*(.+)$/);
            if (!item) break;
            tags.push(item[1].trim().replace(/^["']|["']$/g, ''));
          }
          continue;
        }
        const tagsSingle = line.match(/^tags:\s*(\S.*)$/);
        if (tagsSingle && !tagsInline) {
          tags = [tagsSingle[1].trim().replace(/^["']|["']$/g, '')];
        }
      }
    }
  }
  return { title, tags, body };
}

/** Vault-relative folder of a note, e.g. "10 Projects/Ganglion". */
function folderFor(absPath, vaultRoot) {
  return path.relative(vaultRoot, path.dirname(absPath));
}

function walkMarkdown(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkMarkdown(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const upsertSql = `INSERT INTO documents (path, title, body, folder, tags, mtime, indexed_at)
   VALUES (@path, @title, @body, @folder, @tags, @mtime, datetime('now'))
   ON CONFLICT(path) DO UPDATE SET
     title = excluded.title, body = excluded.body, folder = excluded.folder,
     tags = excluded.tags, mtime = excluded.mtime, indexed_at = datetime('now')`;

/** Index (or reindex) a single note. Returns true if written, false if skipped/gone. */
function indexFile(db, absPath, vaultRoot = resolveVault()) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    // File removed — drop it from the index.
    db.prepare('DELETE FROM documents WHERE path = ?').run(absPath);
    return false;
  }
  const mtime = Math.floor(stat.mtimeMs);
  const existing = db.prepare('SELECT mtime FROM documents WHERE path = ?').get(absPath);
  if (existing && existing.mtime === mtime) return false; // unchanged

  const text = fs.readFileSync(absPath, 'utf8');
  const { title, tags, body } = parseNote(text);
  db.prepare(upsertSql).run({
    path: absPath,
    title: title || path.basename(absPath, '.md'),
    body,
    folder: folderFor(absPath, vaultRoot),
    tags: tags.join(','),
    mtime
  });
  return true;
}

/**
 * Walk the vault, upsert changed notes (mtime-incremental), and prune notes whose
 * files no longer exist. Read-only with respect to the vault files themselves.
 */
function indexVault(db, { vaultRoot = resolveVault(), onProgress } = {}) {
  const files = walkMarkdown(vaultRoot);
  const present = new Set(files);
  let indexed = 0;
  let skipped = 0;
  const run = db.transaction(() => {
    for (let i = 0; i < files.length; i++) {
      if (indexFile(db, files[i], vaultRoot)) indexed++;
      else skipped++;
      if (onProgress && (i % 50 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
    }
    // Prune deleted notes.
    const known = db.prepare('SELECT path FROM documents').all();
    for (const { path: p } of known) {
      if (!present.has(p)) db.prepare('DELETE FROM documents WHERE path = ?').run(p);
    }
  });
  run();
  return { scanned: files.length, indexed, skipped };
}

module.exports = { indexVault, indexFile, parseNote, folderFor, resolveVault, DEFAULT_VAULT };

// CLI entrypoint: `npm run memory:index-vault`
if (require.main === module) {
  const { getDb } = require('../db/db');
  const db = getDb();
  const vaultRoot = resolveVault();
  if (!fs.existsSync(vaultRoot)) {
    console.error(`Vault not found: ${vaultRoot}`);
    process.exit(1);
  }
  process.stdout.write(`Indexing vault at ${vaultRoot}\n`);
  const res = indexVault(db, {
    vaultRoot,
    onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total} notes`)
  });
  process.stdout.write(`\nDone: ${res.indexed} indexed, ${res.skipped} unchanged, ${res.scanned} scanned.\n`);
}
