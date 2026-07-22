# Codebase Map — Ganglion

> Orientation layer for navigating the repo. Read this first.
> Last verified: 2026-07-13.
> Keep in sync: when you add a WS message type, a `memory/*` module, or a DB table,
> update the relevant table below. Message-protocol and status tables live in `CLAUDE.md`.

Ganglion is a browser-based terminal multiplexer + always-on cross-session memory layer.
A single Node process (`server.js`) serves the UI, manages `node-pty` shells over WebSocket,
watches Claude Code hook files, and owns the SQLite memory store.

## Data flows

Each concern is a chain of trigger → server handler → module → storage. All persistent
state lives under `~/.ganglion/` (`state.json`, `memory.db`, `memory-backups/`).

| Flow | Trigger / entry | Server handler (`server.js`) | Module(s) | Storage |
|---|---|---|---|---|
| Terminal session | browser tab → WS `pty:spawn` | `spawnPty`, `handleMessage` (`pty:*`) | `node-pty`; `renderer/renderer.js`, `client.js` | in-mem replay buffer (512KB/tab) → `~/.ganglion/state.json` |
| Status indicator | Claude hook writes `/tmp/ganglion-<tab>-status` | `attachStatusWatcher` (`fs.watch`) → broadcast `tab:status` | `hooks/ganglion-hooks.json`; `renderer.js` recolor | none (transient) |
| Memory capture | `Stop`/`SessionEnd` hook writes `/tmp/ganglion-<tab>-ingest` | `attachIngestWatcher`, `processIngestSignal` | `memory/ingest.js` | `sessions`, `turns` (+`turns_fts`) |
| Memory recall | Ctrl/Cmd+K overlay → WS `memory:search` | `handleMessage` (`memory:*`) | `memory/search.js`; `renderer/memory-panel.js` | reads `turns_fts` + `documents_fts` |
| Memory injection (opt-in) | post-session `maybeDistill(sessionId)` | `maybeDistill` (spawns headless `claude -p`) | `memory/distiller.js` | `memory_facts` → `~/.claude/projects/<slug>/memory/*.md` |
| Vault indexing | boot sweep / `fs.watch` / `memory:import` | `startVaultWatcher`, `drainIngestSignals` | `memory/index-vault.js` | `documents` (+`documents_fts`) |

## Invariants (do not violate)

- **Hooks no-op without `GANGLION_TAB_ID`** — running `claude` outside Ganglion writes nothing.
- **Distiller safety** — only rewrites files stamped `authoredBy: ganglion`; user/native memory
  is read-only; every write is backed up to `~/.ganglion/memory-backups/`. Off by default
  (`GANGLION_DISTILL_ENABLED=1` to enable; set in `ecosystem.config.js` for the pm2 process).
- **Distiller recursion guard** — the `claude -p` subprocess runs with `GANGLION_TAB_ID` unset
  and `GANGLION_DISTILL=1`; the ingest hook no-ops under either, so distillation never re-ingests itself.
- **Ptys survive disconnect** — buffered + replayed on reconnect (`pty:replay`); killed only on explicit `pty:kill`.
- **State saved on every change** to `~/.ganglion/state.json`.
- **`embedding`/`embedding_model` columns are reserved but NULL** — semantic search can be added
  later with no schema rewrite. Do not repurpose them.
- **pm2 needs the full path**: `~/.npm-global/bin/pm2`. Scripts needing env vars must source `.env`.

## Components by layer

| Path | Role |
|---|---|
| `server.js` | Express + `ws` server; pty lifecycle, state persistence, all `fs.watch` watchers (status/tool/ingest/vault), WS message router. |
| `renderer/index.html` | App shell. |
| `renderer/renderer.js` | Tab UI, xterm.js wiring, markdown rendering, draggable divider. |
| `renderer/client.js` | WebSocket client abstraction. |
| `renderer/memory-panel.js` | Global recall overlay (🧠 / Ctrl+K); cited results, click-to-expand context. |
| `renderer/styles.css` | Styles. |
| `memory/ingest.js` | Incremental ingest of transcript JSONL → `turns` (byte-offset tracked; `INSERT OR IGNORE` on `uuid`). |
| `memory/search.js` | FTS5 keyword recall over `turns` + `documents`; two-stage retrieve/rank; structured filters. |
| `memory/distiller.js` | Distills durable facts via headless `claude -p`; maintains native `memory/*.md`. |
| `memory/index-vault.js` | Indexes the Obsidian vault into `documents` (mtime-incremental). |
| `db/db.js` | `better-sqlite3` connection; applies `schema.sql` idempotently on boot. |
| `db/schema.sql` | Memory-store schema (tables below). |
| `hooks/ganglion-hooks.json` | Claude Code hook config (standalone copy). |
| `setup-hooks.js` | Merges hooks into `~/.claude/settings.json` (idempotent; backs up first). |
| `scripts/import-history.js` | One-time backfill: ingest all transcripts + index vault (`npm run memory:import`). |
| `ecosystem.config.js` | pm2 process definition (sets distiller env). |
| `test/*.test.js` | Node test-runner suite (`npm test`). |
| `main.js`, `preload.js` | **Legacy Electron entry points** — superseded by `server.js`. Not used by the web server. |

## Database (`~/.ganglion/memory.db`)

| Table | Purpose |
|---|---|
| `sessions` | One row per Claude Code session (transcript JSONL); tracks `ingested_bytes` offset, `summary`, `status`. |
| `turns` | One row per JSONL user/assistant line; `uuid` dedup key, `parent_uuid` for thread/context expand. |
| `turns_fts` | FTS5 mirror of `turns.text` (porter/unicode61). |
| `memory_facts` | Distilled durable facts; `authored_by` gate, `file_path` back to the `memory/*.md` it maintains. |
| `memory_facts_fts` | FTS5 mirror of `memory_facts` name/description/body. |
| `documents` | Indexed Obsidian vault notes (read-only mirror); `folder`/`tags`/`mtime` for reindex. |
| `documents_fts` | FTS5 mirror of `documents` title/body. |

All `*_fts` tables are external-content FTS5 kept current by triggers — never write to them directly.

## Related docs
- `CLAUDE.md` — run/ops instructions, full WS message protocol, status→color mapping, memory-system narrative.
- `README.md` — **stale** (describes the old Electron/macOS build). Trust `CLAUDE.md` and this map instead.
