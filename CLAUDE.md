# Ganglion — Project Context for Claude Code

## What It Is
Ganglion is a browser-based terminal multiplexer that runs as a Node.js server on this machine. Each tab pairs a real interactive shell (via `node-pty` + `xterm.js`) with a markdown viewer. Tab colors reflect Claude Code's activity state in that terminal.

## How to Run
```bash
cd ~/Documents/dev/Ganglion
node server.js          # or via pm2 (see below)
npm run setup-hooks     # install Claude Code hooks (idempotent)
```

The app is managed by pm2 in production:
```bash
~/.npm-global/bin/pm2 list
~/.npm-global/bin/pm2 restart ganglion
~/.npm-global/bin/pm2 logs ganglion
```

Runs at **http://localhost:3000** by default. Override with `PORT=XXXX`.

## Architecture

| File | Role |
|---|---|
| `server.js` | Express + WebSocket server, node-pty lifecycle, state persistence, status file watchers |
| `renderer/index.html` | App shell |
| `renderer/renderer.js` | Tab UI, xterm.js wiring, markdown rendering, divider |
| `renderer/client.js` | WebSocket client abstraction |
| `renderer/styles.css` | Styles |
| `hooks/ganglion-hooks.json` | Claude Code hook config (standalone copy) |
| `setup-hooks.js` | Merges hooks into `~/.claude/settings.json` |
| `db/schema.sql`, `db/db.js` | SQLite memory store (`~/.ganglion/memory.db`) schema + connection |
| `memory/ingest.js` | Incremental ingest of Claude Code transcript JSONL into `turns` |
| `memory/index-vault.js` | Index the Obsidian vault (`~/Documents/TheBrainOfChris`) into `documents` |
| `memory/search.js` | Keyword recall (FTS5) over sessions + notes; two-stage retrieve/rank |
| `memory/distiller.js` | Distills durable facts via headless `claude -p`, maintains native `memory/*.md` |
| `scripts/import-history.js` | One-time backfill: ingest all transcripts + index the vault (`npm run memory:import`) |
| `renderer/memory-panel.js` | Global "Memory" recall overlay (Ctrl/Cmd+K) |
| `test/*.test.js` | Node test-runner suite (`npm test`) |

## WebSocket Message Protocol
All messages are JSON. Key types:

| Type | Direction | Purpose |
|---|---|---|
| `state:load` | client → server | Load persisted tab state |
| `state:loaded` | server → client | Response with state + replay buffers |
| `state:save` | client → server | Persist tab state |
| `pty:spawn` | client → server | Spawn a new pty for a tab |
| `pty:write` | client → server | Send keystrokes to pty |
| `pty:resize` | client → server | Resize pty |
| `pty:kill` | client → server | Kill pty and clean up |
| `pty:data` | server → client | Terminal output (live) |
| `pty:replay` | server → client | Buffered output replayed on reconnect |
| `pty:exit` | server → client | Pty process exited |
| `pty:cwd` | client → server | Request current working directory |
| `pty:reponame` | client → server | Request git repo name for cwd |
| `tab:status` | server → client | Claude Code status update (idle/working/waiting) |
| `tab:tool` | server → client | Current tool being used by Claude Code |
| `memory:search` | client → server | Keyword/structured recall over sessions + notes |
| `memory:getSession` | client → server | Full session + ordered turns (context expand) |
| `memory:getTurn` | client → server | A turn plus its neighbours (context expand) |
| `memory:projects` | client → server | Distinct project slugs for the filter dropdown |
| `memory:ingested` | server → client | A session was captured (n turns added) |
| `memory:distilled` | server → client | Durable facts were written for a session |

## Memory System
Ganglion is the always-on layer above every Claude Code session, so it doubles as a
cross-session memory store. Three concerns:

- **Capture** — the `Stop`/`SessionEnd` hooks write a JSON ingest signal to
  `/tmp/ganglion-<tabId>-ingest`; the server (`attachIngestWatcher`) reads the referenced
  transcript JSONL and incrementally ingests new turns into `~/.ganglion/memory.db`
  (byte-offset tracked per session; `INSERT OR IGNORE` on the JSONL `uuid`).
- **Recall** — FTS5 keyword search over `turns` **and** the indexed Obsidian vault
  (`documents`), with structured filters (project/date/tool/status). Surfaced in a global
  browser overlay (🧠 Memory / Ctrl+K) with cited results and click-to-expand context.
  Schema reserves `embedding` columns so semantic search can be added later without a rewrite.
- **Injection (opt-in)** — a distiller runs headless `claude -p` after a session and
  maintains the native `~/.claude/projects/<slug>/memory/*.md` + `MEMORY.md` that Claude Code
  injects at session start. **Off by default** — enable with `GANGLION_DISTILL_ENABLED=1`.
  It only rewrites files it authored (stamped `metadata.authoredBy: ganglion`); user/native
  files are read-only and never clobbered, and every write is backed up to
  `~/.ganglion/memory-backups/`. Recursion is prevented by unsetting `GANGLION_TAB_ID` and
  setting `GANGLION_DISTILL=1` on the subprocess (the ingest hook no-ops under either).

Backfill existing history + vault: `npm run memory:import`. Env knobs:
`GANGLION_DISTILL_ENABLED`, `GANGLION_DISTILL_MODEL` (default `haiku`), `GANGLION_VAULT`.

## Session Persistence
Pty processes survive browser close/refresh. Output is buffered in memory per tab (capped at 512KB). On reconnect, the server sends a `pty:replay` message so the terminal restores history. Processes are only killed on explicit `pty:kill`.

## Claude Code Status Indicators
Each pty is spawned with `GANGLION_TAB_ID=<uuid>` in its env. Claude Code hooks write status tokens to `/tmp/ganglion-<tabId>-status` and tool names to `/tmp/ganglion-<tabId>-tool`. The server watches these files with `fs.watch` and broadcasts `tab:status` / `tab:tool` events.

| Status | Color | Trigger |
|---|---|---|
| `working` | green | `UserPromptSubmit`, `PreToolUse` |
| `waiting` | red | `Notification` (needs your input) |
| `idle` | gray | `Stop`, `SessionStart`, `SessionEnd` |

Hooks are no-ops when `GANGLION_TAB_ID` is unset (running `claude` outside Ganglion).

## State Persistence
Tab state (names, cwd, open markdown files, divider positions) is saved to `~/.ganglion/state.json` on every change and restored on load.

## Key Constraints
- `claudedev` cannot sudo — any system-level changes need Chris or SSH as `chris@localhost`
- pm2 must be invoked with full path: `~/.npm-global/bin/pm2`
- Scripts needing env vars must source `.env` explicitly
- The README.md still references the old Electron/macOS setup — the app is now a Node.js web server
