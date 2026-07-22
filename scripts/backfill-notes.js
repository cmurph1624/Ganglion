'use strict';

// One-time backfill: generate a session note (sessions.summary) for every existing
// session that doesn't have one yet. Idempotent + resumable — it only selects sessions
// with an empty summary, so you can Ctrl-C and re-run to continue.
//
// Run from a PLAIN OS terminal, NOT a Ganglion tab: outside a tab GANGLION_TAB_ID is
// unset, so no ingest signal is produced (no recursion) and it can't kill a Ganglion pty.
//
//   node scripts/backfill-notes.js
//   GANGLION_DISTILL_MODEL=haiku node scripts/backfill-notes.js   # cheaper
//
// The running server keeps memory.db open in WAL mode; this opens its own connection.

const { openDb } = require('../db/db');
const distiller = require('../memory/distiller');

// Session notes are the durable searchable artifact — default to the stronger model
// unless the caller overrides it. (Matches the distiller's live pm2 setting.)
if (!process.env.GANGLION_DISTILL_MODEL) process.env.GANGLION_DISTILL_MODEL = 'sonnet';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = openDb();
  db.pragma('busy_timeout = 5000'); // tolerate the live server writing concurrently

  const rows = db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE (summary IS NULL OR summary = '') AND turn_count > 0
       ORDER BY ended_at DESC`
    )
    .all();

  if (rows.length === 0) {
    console.log('Nothing to backfill — every session already has a note.');
    return;
  }

  console.log(`Backfilling ${rows.length} session note(s) using model ${process.env.GANGLION_DISTILL_MODEL}…`);
  let done = 0;
  let wrote = 0;
  for (const { session_id: sessionId } of rows) {
    done++;
    try {
      const res = await distiller.distillSession(db, sessionId);
      if (res.updated) wrote++;
      console.log(`  [${done}/${rows.length}] ${sessionId} — ${res.updated ? `note ${res.chars} chars` : 'skipped (no note)'}`);
    } catch (err) {
      console.error(`  [${done}/${rows.length}] ${sessionId} — FAILED: ${err.message}`);
    }
    await sleep(250); // gentle pacing between claude -p calls
  }
  console.log(`Done. Wrote ${wrote} note(s); ${done - wrote} skipped/failed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
