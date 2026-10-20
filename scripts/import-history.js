'use strict';

// One-time (and safely re-runnable) backfill: ingest every Claude Code transcript on
// disk into the memory store, then index the Obsidian vault. Idempotent — transcript
// offsets and note mtimes mean a re-run only processes what changed.
//
//   npm run memory:import

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../db/db');
const { ingestTranscript } = require('../memory/ingest');
const { indexVault, resolveVault } = require('../memory/index-vault');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function findTranscripts(dir) {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projDir = path.join(dir, p.name);
    let files;
    try {
      files = fs.readdirSync(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(path.join(projDir, f));
    }
  }
  return out;
}

function main() {
  const db = getDb();

  const transcripts = findTranscripts(PROJECTS_DIR);
  process.stdout.write(`Found ${transcripts.length} transcripts in ${PROJECTS_DIR}\n`);
  let totalAdded = 0;
  let sessionsTouched = 0;
  for (let i = 0; i < transcripts.length; i++) {
    let added = 0;
    try {
      ({ added } = ingestTranscript(db, transcripts[i]));
    } catch (err) {
      process.stdout.write(`\n  ! ${path.basename(transcripts[i])}: ${err.message}\n`);
    }
    if (added > 0) sessionsTouched++;
    totalAdded += added;
    process.stdout.write(`\r  ${i + 1}/${transcripts.length} transcripts  (+${totalAdded} turns)`);
  }
  process.stdout.write(`\nIngested ${totalAdded} new turns across ${sessionsTouched} sessions.\n`);

  const vaultRoot = resolveVault();
  if (fs.existsSync(vaultRoot)) {
    process.stdout.write(`Indexing vault at ${vaultRoot}\n`);
    const v = indexVault(db, {
      vaultRoot,
      onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total} notes`)
    });
    process.stdout.write(`\nVault: ${v.indexed} indexed, ${v.skipped} unchanged, ${v.scanned} scanned.\n`);
  } else {
    process.stdout.write(`Vault not found at ${vaultRoot} — skipping note index.\n`);
  }

  const sessions = db.prepare('SELECT count(*) c FROM sessions').get().c;
  const turns = db.prepare('SELECT count(*) c FROM turns').get().c;
  const docs = db.prepare('SELECT count(*) c FROM documents').get().c;
  process.stdout.write(`\nMemory store now holds ${sessions} sessions, ${turns} turns, ${docs} notes.\n`);
}

main();
