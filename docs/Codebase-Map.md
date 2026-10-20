# Codebase Map — Ganglion

> Orientation layer for navigating the repo. Read this first.
> Last verified: 2026-07-25.
> Keep in sync: when you add a WS message type, a `memory/*` module, or a DB table,
> update the relevant table below. Message-protocol and status tables live in `CLAUDE.md`.

Ganglion is a terminal multiplexer + always-on cross-session memory layer.
A single Node process (`server.js`) serves the UI, manages `node-pty` shells over WebSocket,
watches Claude Code hook files, and owns the SQLite memory store.

It runs on `stigmergylabs` (a GMKtec mini PC, Ubuntu 24.04) as the systemd `ganglion` service (`deploy/ganglion.service`,
config in `~/.ganglion/ganglion.env`). Browsers attach to that one process and **mirror the same
ptys** — in practice the Mac, over Tailscale.

## Data flows

Each concern is a chain of trigger → server handler → module → storage. All persistent
state lives under `~/.ganglion/` (`state.json`, `memory.db`, `memory-backups/`).

| Flow | Trigger / entry | Server handler (`server.js`) | Module(s) | Storage |
|---|---|---|---|---|
| Terminal session | browser tab → WS `pty:spawn` | `spawnPty`, `handleMessage` (`pty:*`) | `node-pty`; `renderer/renderer.js`, `client.js`; `lib/scrollback.js` | in-mem replay buffer (512KB/tab), flushed to `~/.ganglion/scrollback/<tab>.log`; tab list → `~/.ganglion/state.json` |
| Terminal sizing | any client → WS `pty:resize` | `handleMessage`, `applySize` | `lib/pty-sizing.js` | in-mem registry (per client, per tab) |
| Status indicator | Claude hook writes `<tmp>/ganglion-<tab>-status` | `attachStatusWatcher` (`fs.watch`) → broadcast `tab:status` | `lib/platform.js`; `hooks/`; `renderer.js` recolor | none (transient) |
| Phone alerts (opt-in) | same status-file change | `attachStatusWatcher` → `alerter.onStatus` → `publishNtfy` | `lib/phone-alerts.js` | none (in-mem timers per tab) |
| Memory capture | `Stop`/`SessionEnd` hook writes `<tmp>/ganglion-<tab>-ingest` | `attachIngestWatcher`, `processIngestSignal` | `memory/ingest.js` | `sessions`, `turns` (+`turns_fts`) |
| Memory recall | Ctrl/Cmd+K overlay → WS `memory:search` | `handleMessage` (`memory:*`) | `memory/search.js`; `renderer/memory-panel.js` | reads `turns_fts` + `sessions_fts` + `documents_fts` |
| Session notes (opt-in) | post-session `maybeDistill(sessionId)` | `maybeDistill` (spawns headless `claude -p`) | `memory/distiller.js` | `sessions.summary` (+`sessions_fts`) |
| Vault indexing | boot sweep / `fs.watch` / `memory:import` | `startVaultWatcher`, `drainIngestSignals` | `memory/index-vault.js` | `documents` (+`documents_fts`) |

## Invariants (do not violate)

- **Signal paths come from `lib/platform.js`** — `<tmp>` above is `os.tmpdir()` (`/tmp`, or
  `$TMPDIR` if set). The hooks *write* these files and `server.js` *reads* them; if the
  two halves ever disagree about the directory, Ganglion boots and terminals work while status
  dots never update and no session is ever ingested — silently. Never hardcode `/tmp`.
- **Hooks no-op without `GANGLION_TAB_ID`** — running `claude` outside Ganglion writes nothing.
- **Every client mirrors one set of ptys** — `broadcast()` fans pty output to every client. The
  pty is sized to the **minimum over attached clients** (`lib/pty-sizing.js`), tmux-style, so the
  grid fits inside every viewport. Never resize a pty straight from one client's message.
- **Inactive panes stay laid out** — `styles.css` hides them with `visibility: hidden`, never
  `display: none`. xterm's fit addon cannot measure a `display: none` terminal, so a background
  tab would keep a stale size while its pty draws at the real width, and output from agents
  running in background tabs (plus replay) lands garbled. Consequence: every client reports a
  size for every tab, so the minimum-over-clients rule applies to all tabs, not just open ones.
- **Distiller writes session notes only** — one narrative note into `sessions.summary`, surfaced
  in recall as "Session notes". It does **not** touch Claude Code's native `memory/*.md`; native
  auto-memory solely owns durable injected facts. Off by default (`GANGLION_DISTILL_ENABLED=1`
  to enable; set in `~/.ganglion/ganglion.env` for the systemd service, with `GANGLION_DISTILL_MODEL=sonnet`).
- **Distiller recursion guard** — the `claude -p` subprocess runs with `GANGLION_TAB_ID` unset
  and `GANGLION_DISTILL=1`; the ingest hook no-ops under either, so distillation never re-ingests itself.
- **One key, one owner** — `renderer/terminal-keys.js` decides whether a keydown belongs to the
  pty, the browser, or the app; `renderer.js` and `memory-panel.js` both ask it rather than
  testing modifiers themselves. When they disagreed, Ctrl+K fired twice (xterm wrote `^K` to the
  pty *and* the overlay opened) — and `preventDefault` cannot undo that, since it does not stop
  propagation and xterm has already acted. Add an app shortcut in that module, not at a call site.
- **Ptys survive disconnect** — buffered + replayed on reconnect (`pty:replay`); killed only on explicit `pty:kill`.
- **Scrollback survives a restart, shells don't** — buffers are flushed to `~/.ganglion/scrollback/`
  every 5s and on SIGTERM (`lib/scrollback.js`); a respawned pane replays the saved text above a
  fresh shell. `cleanup()` sets `shuttingDown` first so the exit handlers it triggers don't delete them.
- **State saved on every change** to `~/.ganglion/state.json`.
- **`embedding`/`embedding_model` columns are reserved but NULL** — semantic search can be added
  later with no schema rewrite. Do not repurpose them.
- **Restarts kill every pty** — a deploy (`deploy/deploy.sh`) or `systemctl restart ganglion`
  ends every shell, including the one running the command. Never do either from inside a Ganglion
  tab; use a plain SSH shell. Deploy is gated (`v*` tag or `workflow_dispatch`, never a merge to
  `main`); details in `CLAUDE.md`. Scripts needing env vars must source `.env`.

## Components by layer

| Path | Role |
|---|---|
| `server.js` | Express + `ws` server; pty lifecycle, state persistence, all `fs.watch` watchers (status/tool/ingest/vault), WS message router. |
| `renderer/index.html` | App shell. |
| `renderer/renderer.js` | Tab UI, xterm.js wiring, markdown rendering, draggable divider. |
| `renderer/client.js` | WebSocket client abstraction. |
| `renderer/memory-panel.js` | Global recall overlay (🧠 / Ctrl+K); cited results, click-to-expand context. |
| `renderer/terminal-keys.js` | Pure key policy shared by the terminals and the overlay: pty vs browser vs app. Dual-loaded (`<script>` + `require`). |
| `renderer/terminal-search.js` | Scrollback search bar per terminal (Ctrl+Shift+F / Cmd+F), on `@xterm/addon-search`. |
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
| `deploy/ganglion.service`, `deploy/deploy.sh`, `deploy/setup-server.sh` | systemd unit, CI-invoked redeploy, one-time host bootstrap. |
| `test/*.test.js` | Node test-runner suite (`npm test`). |
| `lib/platform.js` | Machine bindings: shell + args, signal-file paths, cwd probe, `claude` binary. |
| `lib/pty-sizing.js` | Per-client size registry; the pty takes the minimum over attached clients. |
| `lib/phone-alerts.js` | Phone alerts: per-tab status tracking, alert delay, ntfy JSON publish. |
| `lib/server-probe.js` | Port resolution (`PORT`, default 3000). |
| `lib/scrollback.js` | Scrollback on disk across restarts: load/save/prune, restored-buffer reset + separator. |
| `lib/hook-signal.js` | Pure write-planning for the hook signal files (used by `hooks/ganglion-signal.js`). |

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
