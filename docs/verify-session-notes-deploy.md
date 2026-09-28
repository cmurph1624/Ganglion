# Verify — DB-backed session notes deploy

Read-only verification that the **repoint-distiller-to-session-notes** change is fully
live on this box. Open this in a Ganglion markdown viewer and run the checks from the
paired terminal.

> ⚠️ **You are (probably) inside a Ganglion tab.** `echo "$GANGLION_TAB_ID"` will print a
> UUID. That means **do NOT** `sudo systemctl restart ganglion` or trigger a deploy — it kills
> every pty, including the one running this very session. Everything below is **read-only**. If
> a restart is ever needed, do it from a plain SSH shell, never from a tab.

What "done" means:
- distiller writes ONE narrative note per session into `sessions.summary` (not native memory)
- notes are indexed into `sessions_fts` and searchable as the **"Session notes"** source
- live process runs with `GANGLION_DISTILL_ENABLED=1`, `GANGLION_DISTILL_MODEL=sonnet`
- native memory dir is untouched (no distiller-authored files)

---

## 1. Repo state (the change has been merged — PR #5)

```bash
cd ~/dev/Ganglion
git log --oneline -1 -- memory/distiller.js   # distiller change is on the deployed ref
```

## 2. Tests (expect 0 fail)

```bash
cd ~/dev/Ganglion && npm test 2>&1 | grep -E '^# (pass|fail)'
```

## 3. Live distiller config (read-only — does NOT restart anything)

Reads the environment of the running service process, not the env file, so it reflects what
is actually live:

```bash
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value ganglion)/environ | grep GANGLION_DISTILL
# -> GANGLION_DISTILL_ENABLED=1
#    GANGLION_DISTILL_MODEL=sonnet
```

## 4. DB + FTS + recall (one script, prints PASS/FAIL)

```bash
cd ~/dev/Ganglion && node <<'EOF'
const { openDb } = require('./db/db');
const { search } = require('./memory/search');
const db = openDb();
const ok = [];
const notes = db.prepare("SELECT count(*) c FROM sessions WHERE summary IS NOT NULL AND summary!=''").get().c;
const fts   = db.prepare("SELECT count(*) c FROM sessions_fts").get().c;
ok.push(['sessions_fts table exists', !!db.prepare("SELECT name FROM sqlite_master WHERE name='sessions_fts'").get()]);
ok.push(['>=1 session note written', notes > 0, `notes=${notes}`]);
ok.push(['FTS index in sync with notes', notes === fts, `notes=${notes} fts=${fts}`]);
const sample = db.prepare("SELECT summary FROM sessions WHERE summary IS NOT NULL AND summary!='' LIMIT 1").get();
const term = (sample ? sample.summary : 'the').split(/\s+/).find(w => w.length > 5) || 'the';
const hits = search(db, { query: term, source: 'summary' });
ok.push([`recall works (query "${term}")`, hits.length > 0, `${hits.length} hit(s)`]);
let pass = true;
for (const [name, good, extra] of ok) { if (!good) pass = false; console.log(`${good ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ('+extra+')' : ''}`); }
console.log(pass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
EOF
```

## 5. Native memory stayed clean (no distiller-authored files)

```bash
grep -rl 'authoredBy: *ganglion' ~/.claude/projects/*/memory/ 2>/dev/null
# -> (no output = good; no distiller-authored files)
```

## 6. Browser smoke test (human)

Ganglion → **Ctrl/Cmd+K** → source **"Session notes"** → search a known term → a result with
a green **"session note"** badge should appear and expand to the full note.

---

### Original deploy snapshot (2026-07-22, previous host — kept for history)
- Tests: 32 pass / 0 fail
- Backfill over 137 sessions: **39 notes, 98 skipped `(no note)`, 0 failed**
- PR: https://github.com/cmurph1624/Ganglion/pull/5
