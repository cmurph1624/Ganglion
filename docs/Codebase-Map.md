# Codebase Map — Ganglion

> Orientation layer for navigating the repo. Read this first.
> Last verified: 2026-07-25.
> Keep in sync: when you add a WS message type, a `memory/*` module, or a DB table,
> update the relevant table below. Message-protocol and status tables live in `CLAUDE.md`.

Ganglion is a terminal multiplexer + always-on cross-session memory layer.
A single Node process (`server.js`) serves the UI, manages `node-pty` shells over WebSocket,
watches Claude Code hook files, and owns the SQLite memory store.

Two front-ends attach to that one process and **mirror the same ptys**: a browser (any machine
that can reach the port) and an optional Electron desktop shell (`electron/`, same machine).
The desktop shell is a window only — it never spawns a server and never loads a native module.

## Data flows

Each concern is a chain of trigger → server handler → module → storage. All persistent
state lives under `~/.ganglion/` (`state.json`, `memory.db`, `memory-backups/`).

| Flow | Trigger / entry | Server handler (`server.js`) | Module(s) | Storage |
|---|---|---|---|---|
| Terminal session | browser tab or desktop window → WS `pty:spawn` | `spawnPty`, `handleMessage` (`pty:*`) | `node-pty`; `renderer/renderer.js`, `client.js` | in-mem replay buffer (512KB/tab) → `~/.ganglion/state.json` |
| Terminal sizing | any client → WS `pty:resize` | `handleMessage`, `applySize` | `lib/pty-sizing.js` | in-mem registry (per client, per tab) |
| Status indicator | Claude hook writes `<tmp>/ganglion-<tab>-status` | `attachStatusWatcher` (`fs.watch`) → broadcast `tab:status` | `lib/platform.js`; `hooks/`; `renderer.js` recolor | none (transient) |
| Memory capture | `Stop`/`SessionEnd` hook writes `<tmp>/ganglion-<tab>-ingest` | `attachIngestWatcher`, `processIngestSignal` | `memory/ingest.js` | `sessions`, `turns` (+`turns_fts`) |
| Memory recall | Ctrl/Cmd+K overlay → WS `memory:search` | `handleMessage` (`memory:*`) | `memory/search.js`; `renderer/memory-panel.js` | reads `turns_fts` + `sessions_fts` + `documents_fts` |
| Session notes (opt-in) | post-session `maybeDistill(sessionId)` | `maybeDistill` (spawns headless `claude -p`) | `memory/distiller.js` | `sessions.summary` (+`sessions_fts`) |
| Vault indexing | boot sweep / `fs.watch` / `memory:import` | `startVaultWatcher`, `drainIngestSignals` | `memory/index-vault.js` | `documents` (+`documents_fts`) |

## Invariants (do not violate)

- **Signal paths come from `lib/platform.js`** — `<tmp>` above is `os.tmpdir()` (`%TEMP%` on
  Windows, `/tmp` on POSIX). The hooks *write* these files and `server.js` *reads* them; if the
  two halves ever disagree about the directory, Ganglion boots and terminals work while status
  dots never update and no session is ever ingested — silently. Never hardcode `/tmp`.
- **Hooks no-op without `GANGLION_TAB_ID`** — running `claude` outside Ganglion writes nothing.
- **Both front-ends mirror one set of ptys** — `broadcast()` fans pty output to every client. The
  pty is sized to the **minimum over attached clients** (`lib/pty-sizing.js`), tmux-style, so the
  grid fits inside every viewport. Never resize a pty straight from one client's message.
- **The desktop shell never spawns a server and never loads a native module** — it opens a window
  onto the pm2-managed process. Requiring `node-pty`/`better-sqlite3`/`db/`/`memory/` from
  `electron/` would reintroduce an Electron ABI rebuild step and let a closing window kill ptys
  the browser is still using. Launch it as `electron electron/main.js`, never `electron .` (which
  would resolve `package.json:main` and boot `server.js` inside Electron).
- **Distiller writes session notes only** — one narrative note into `sessions.summary`, surfaced
  in recall as "Session notes". It does **not** touch Claude Code's native `memory/*.md`; native
  auto-memory solely owns durable injected facts. Off by default (`GANGLION_DISTILL_ENABLED=1`
  to enable; set in `ecosystem.config.js` for the pm2 process).
- **Distiller recursion guard** — the `claude -p` subprocess runs with `GANGLION_TAB_ID` unset
  and `GANGLION_DISTILL=1`; the ingest hook no-ops under either, so distillation never re-ingests itself.
- **Ptys survive disconnect** — buffered + replayed on reconnect (`pty:replay`); killed only on explicit `pty:kill`.
- **State saved on every change** to `~/.ganglion/state.json`.
- **`embedding`/`embedding_model` columns are reserved but NULL** — semantic search can be added
  later with no schema rewrite. Do not repurpose them.
- **pm2 must be invoked as `node …\node_modules\pm2\bin\pm2`**, not via `pm2.cmd` — the npm shim
  falls back to a bare `node` lookup and dies in an elevated shell with `'"node"' is not
  recognized`. The daemon runs in session 0, so it needs an **elevated** shell regardless
  (unelevated gives `connect EPERM \\.\pipe\rpc.sock`). Full command in `CLAUDE.md`.
  Never `pm2 restart ganglion` from inside a Ganglion tab — it kills the pty running the command.
  Scripts needing env vars must source `.env`.

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
| `memory/distiller.js` | Distills one narrative session note via headless `claude -p` → `sessions.summary`. |
| `memory/index-vault.js` | Indexes the Obsidian vault into `documents` (mtime-incremental). |
| `db/db.js` | `better-sqlite3` connection; applies `schema.sql` idempotently on boot. |
| `db/schema.sql` | Memory-store schema (tables below). |
| `hooks/ganglion-hooks.json` | Claude Code hook config (standalone copy). |
| `setup-hooks.js` | Merges hooks into `~/.claude/settings.json` (idempotent; backs up first). |
| `scripts/import-history.js` | One-time backfill: ingest all transcripts + index vault (`npm run memory:import`). |
| `ecosystem.config.js` | pm2 process definition (sets distiller env). |
| `test/*.test.js` | Node test-runner suite (`npm test`). |
| `lib/platform.js` | Windows/POSIX bindings: shell + args, signal-file paths, cwd probe, `claude` binary. |
| `lib/pty-sizing.js` | Per-client size registry; the pty takes the minimum over attached clients. |
| `lib/server-probe.js` | Port resolution (shared with `server.js`) + non-throwing HTTP health probe. |
| `lib/window-bounds.js` | Validates persisted desktop-window bounds against the current displays. |
| `lib/hook-signal.js` | Pure write-planning for the hook signal files (used by `hooks/ganglion-signal.js`). |
| `electron/main.js` | Desktop shell: window, remembered bounds, health probe/retry, file dialog, key policy. |
| `electron/preload.js` | `contextBridge` surface exposed to the page (`isDesktop`, `openMarkdown`, `retry`). |
| `electron/retry.html` | Standalone "waiting for server" screen; loads none of `renderer/`. |

## Database (`~/.ganglion/memory.db`)

| Table | Purpose |
|---|---|
| `sessions` | One row per Claude Code session (transcript JSONL); tracks `ingested_bytes` offset, `summary`, `status`. |
| `sessions_fts` | FTS5 mirror of `sessions.summary` — the "Session notes" recall source; kept current by the `sessions_au` trigger. |
| `turns` | One row per JSONL user/assistant line; `uuid` dedup key, `parent_uuid` for thread/context expand. |
| `turns_fts` | FTS5 mirror of `turns.text` (porter/unicode61). |
| `documents` | Indexed Obsidian vault notes (read-only mirror); `folder`/`tags`/`mtime` for reindex. |
| `documents_fts` | FTS5 mirror of `documents` title/body. |

All `*_fts` tables are external-content FTS5 kept current by triggers — never write to them directly.

> `memory_facts` / `memory_facts_fts` are **retired** — fresh DBs no longer create them (see the
> note in `db/schema.sql` and the assertion in `test/db.test.js`). A pre-existing database keeps
> a frozen, orphaned copy; do not read or write it.

## Related docs
- `CLAUDE.md` — run/ops instructions, full WS message protocol, status→color mapping, memory-system narrative.
- `README.md` — install/run for both front-ends, mirroring behaviour, project layout.
