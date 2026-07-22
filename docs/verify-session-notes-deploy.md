# Verify — DB-backed session notes deploy

Read-only verification that the **repoint-distiller-to-session-notes** change is fully
live on this box. Open this in a Ganglion markdown viewer and run the checks from the
paired terminal.

> ⚠️ **You are (probably) inside a Ganglion tab.** `echo "$GANGLION_TAB_ID"` will print a
> UUID. That means **do NOT** `pm2 restart ganglion` / `pm2 restart ecosystem.config.js` —
> it kills the pty running this very session. Everything below is **read-only**; the deploy
> + restart already happened from a plain SSH shell. If a restart is ever needed, do it from
> `ssh claudedev`, never from a tab.

What "done" means:
- distiller writes ONE narrative note per session into `sessions.summary` (not native memory)
- notes are indexed into `sessions_fts` and searchable as the **"Session notes"** source
- live process runs with `GANGLION_DISTILL_ENABLED=1`, `GANGLION_DISTILL_MODEL=sonnet`
- native memory dir is untouched (no distiller-authored files)

---

## 1. Repo state (expect branch + 2 commits)

```bash
cd ~/Documents/dev/Ganglion
git branch --show-current            # -> repoint-distiller-session-notes
git log --oneline main..HEAD         # -> "Document DB-backed session notes..." + "Repoint distiller..."
```

## 2. Tests (expect 32 pass / 0 fail)

```bash
cd ~/Documents/dev/Ganglion && node --test test/*.test.js 2>&1 | tail -6
```

## 3. Live distiller config (read-only — does NOT restart anything)

```bash
~/.npm-global/bin/pm2 jlist | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d).find(x=>x.name==="ganglion");console.log("DISTILL_ENABLED=",p.pm2_env.GANGLION_DISTILL_ENABLED,"MODEL=",p.pm2_env.GANGLION_DISTILL_MODEL)})'
# -> DISTILL_ENABLED= 1 MODEL= sonnet
```

## 4. DB + FTS + recall (one script, prints PASS/FAIL)

```bash
cd ~/Documents/dev/Ganglion && node <<'EOF'
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

## 5. Native memory stayed clean (expect exactly 5 files, none distiller-authored)

```bash
ls -1 ~/.claude/projects/-home-claudedev-Documents-dev-Ganglion/memory/*.md | xargs -n1 basename
# -> MEMORY.md, ganglion-session-capture-hooks.md, para-vault-conventions.md,
#    sap-help-portal-api-pagecontent.md, sap-help-portal-pdf-extraction.md
grep -rl 'authoredBy: *ganglion' ~/.claude/projects/-home-claudedev-Documents-dev-Ganglion/memory/ 2>/dev/null
# -> (no output = good; no distiller-authored files)
```

## 6. Browser smoke test (human)

Ganglion → **Ctrl/Cmd+K** → source **"Session notes"** → search a known term → a result with
a green **"session note"** badge should appear and expand to the full note.

---

### Deploy snapshot (2026-07-22)
- Tests: 32 pass / 0 fail
- Backfill over 137 sessions: **39 notes, 98 skipped `(no note)`, 0 failed**
- PR: https://github.com/cmurph1624/Ganglion/pull/5 (open, base `main`)
