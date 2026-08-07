# Ganglion — Project Context for Claude Code

> **Codebase Map:** see `docs/Codebase-Map.md` for the repo orientation layer (data flows, invariants, component + DB tables). Read it first when navigating the code.

## What It Is
Ganglion is a terminal multiplexer that runs as a Node.js server on this machine. Each tab pairs a real interactive shell (via `node-pty` + `xterm.js`) with a markdown viewer. Tab colors reflect Claude Code's activity state in that terminal.

Two front-ends attach to that one server and **mirror the same live ptys**: a browser (used from the Mac) and an Electron desktop shell (used locally over RDP). Both can be connected at once.

## How to Run
```powershell
cd C:\Users\rdpuser\Documents\Dev\Ganglion
node server.js          # or via pm2 (see below)
npm run setup-hooks     # install Claude Code hooks (idempotent)
npm run desktop         # optional Electron window onto the running server
```

The app is managed by pm2 in production:
```powershell
# ELEVATED shell required (the daemon runs in session 0; unelevated gives
# `connect EPERM \\.\pipe\rpc.sock`).
$node = "C:\Program Files\nodejs\node.exe"
$pm2  = "C:\Users\rdpuser\AppData\Roaming\npm\node_modules\pm2\bin\pm2"

whoami                                 # must be stigmergylabs\rdpuser
& $node $pm2 list
& $node $pm2 restart ganglion
& $node $pm2 logs ganglion --lines 20 --nostream
```

> **Do not use `pm2.cmd`.** The npm shim falls back to a bare `node` lookup
> (`SET "_prog=node"`), which fails in an elevated shell with the cryptic
> `'"node"' is not recognized` — nothing to do with pm2. Invoking node directly against
> `node_modules\pm2\bin\pm2` sidesteps both PATH and PATHEXT.
>
> The paths are hardcoded rather than `$env:APPDATA` on purpose: if UAC ever elevates a
> *different* admin account, `$env:APPDATA` resolves to that profile and you spawn a
> second daemon instead of talking to the running one. Hence the `whoami` check.

> ⚠️ Never `pm2 restart ganglion` from inside a Ganglion tab — it kills the pty running the command. Use a shell outside Ganglion. See `docs/verify-session-notes-deploy.md`.

Runs at **http://localhost:3000** by default. Override with `PORT=XXXX`. `GANGLION_HOST` pins the listen interface (defaults to `0.0.0.0`, which is what lets the Mac connect).

## Desktop Client
`npm run desktop` opens an Electron window onto the **already-running** server. Two rules keep it cheap and safe:

- **It never spawns a server.** pm2 owns the lifecycle. On launch it probes the port and shows `electron/retry.html` if nothing answers, connecting automatically once the server returns. Closing the window is as harmless as closing a browser tab — ptys keep running.
- **It never loads a native module.** Because it only opens a window, `node-pty` and `better-sqlite3` are never required from Electron — so **there is no `electron-rebuild` step**. Requiring `db/`, `memory/`, or either native module from `electron/` would break this.

Launch it as `electron electron/main.js` (what the `desktop` script does), never `electron .` — that resolves `package.json:main`, which is `server.js`, and would boot Express inside Electron.

Window bounds persist to `~/.ganglion/window.json`. The window has no menu, so terminal keys (`Ctrl+W`, `Ctrl+T`, `Ctrl+L`, `Ctrl+R`, `F5`) reach the shell instead of browser chrome — the main reason the desktop shell exists.

## Architecture

| File | Role |
|---|---|
| `server.js` | Express + WebSocket server, node-pty lifecycle, state persistence, status file watchers |
| `renderer/index.html` | App shell |
| `renderer/renderer.js` | Tab UI, xterm.js wiring, markdown rendering, divider |
| `renderer/client.js` | WebSocket client abstraction |
| `renderer/terminal-keys.js` | Shared key policy — decides pty vs browser vs app for each keydown; read by both the terminals and the Memory overlay |
| `renderer/clipboard.js` | Clipboard writer with an execCommand fallback (the Mac front-end is not a secure context) |
| `renderer/terminal-copy.js` | Binds the key policy + clipboard onto a live xterm: copy-on-selection (no key press), plus Ctrl+C copy-then-clear |
| `renderer/styles.css` | Styles |
| `hooks/ganglion-hooks.json` | Claude Code hook config (standalone copy) |
| `setup-hooks.js` | Merges hooks into `~/.claude/settings.json` |
| `db/schema.sql`, `db/db.js` | SQLite memory store (`~/.ganglion/memory.db`) schema + connection |
| `memory/ingest.js` | Incremental ingest of Claude Code transcript JSONL into `turns` |
| `memory/index-vault.js` | Index the Obsidian vault (`~/Documents/TheBrainOfChris`) into `documents` |
| `memory/search.js` | Keyword recall (FTS5) over sessions + notes; two-stage retrieve/rank |
| `memory/distiller.js` | Distills one narrative session note via headless `claude -p` into `sessions.summary` |
| `lib/platform.js` | Windows/POSIX bindings: shell + args, signal-file paths, cwd probe, `claude` binary |
| `lib/osc7.js` | Reads the shell's OSC 7 cwd announcements out of the pty stream (the Windows cwd source) |
| `lib/pty-sizing.js` | Per-client size registry; pty takes the minimum over attached clients |
| `lib/tab-state.js` | Splits shared tab data (server-owned) from per-client view state (localStorage); applies per-tab mutations. Loaded by `server.js`, by the tests, and by the browser via the `/tab-state.js` route |
| `lib/server-probe.js` | Port resolution (shared with `server.js`) + non-throwing health probe |
| `lib/window-bounds.js` | Validates persisted desktop-window bounds against current displays |
| `electron/main.js` | Desktop shell: window, bounds, health probe/retry, file dialog, key policy |
| `electron/preload.js` | `contextBridge` surface (`isDesktop`, `openMarkdown`, `retry`) |
| `electron/retry.html` | Standalone "waiting for server" screen |
| `scripts/import-history.js` | One-time backfill: ingest all transcripts + index the vault (`npm run memory:import`) |
| `renderer/memory-panel.js` | Global "Memory" recall overlay (Ctrl/Cmd+K) |
| `test/*.test.js` | Node test-runner suite (`npm test`) |

## WebSocket Message Protocol
All messages are JSON. Key types:

| Type | Direction | Purpose |
|---|---|---|
| `state:load` | client → server | Load persisted tab state |
| `state:loaded` | server → client | **Shared** tab state + replay buffers. Carries no view state — the client merges its own from `localStorage` |
| `tab:created` | both ways | A tab was opened. Client → server to register it; rebroadcast to every client (including the sender) so the other front-end draws it |
| `tab:updated` | both ways | A shared field changed (name, cwd, markdownFile, autoName). A patch that changes nothing is dropped rather than rebroadcast — `syncCwds()` polls in every front-end at once |
| `tab:closed` | both ways | A tab was closed. The originating client also sends `pty:kill`; receivers only tear down their view |
| `pty:spawn` | client → server | Spawn a new pty for a tab |
| `pty:write` | client → server | Send keystrokes to pty |
| `pty:resize` | client → server | Report this client's viewport. The pty is set to the **minimum over attached clients** (`lib/pty-sizing.js`), not to the last message — otherwise two mirrored windows of different sizes fight |
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
- **Recall** — FTS5 keyword search over `turns`, the per-session narrative notes
  (`sessions.summary`, surfaced as the **"Session notes"** source), **and** the indexed
  Obsidian vault (`documents`), with structured filters (project/date/tool/status). Surfaced
  in a global browser overlay (🧠 Memory / Ctrl+K) with cited results and click-to-expand
  context. Schema reserves `embedding` columns so semantic search can be added later without
  a rewrite.
- **Distillation → session notes** — after a session, a distiller runs headless `claude -p`
  and writes ONE narrative note (≈120–250 words) into the `sessions.summary` column of
  `~/.ganglion/memory.db`, auto-indexed into `sessions_fts` (via the `sessions_au` trigger)
  and surfaced as the **"Session notes"** recall source. It **does not** touch Claude Code's
  native memory files (`~/.claude/projects/<slug>/memory/*.md`) — native auto-memory solely
  owns durable, injected facts, so the old two-writers collision is gone. **Off by default** —
  enable with `GANGLION_DISTILL_ENABLED=1`. Non-substantive sessions (startup-only shells,
  headless cron runs) yield no note (the model returns `(no note)`). Recursion is prevented by
  unsetting `GANGLION_TAB_ID` and setting `GANGLION_DISTILL=1` on the subprocess (the ingest
  hook no-ops under either).

Backfill notes for existing sessions: `node scripts/backfill-notes.js` (resumable — only
selects sessions whose `summary` is still empty). Backfill turn history + vault:
`npm run memory:import`. Env knobs: `GANGLION_DISTILL_ENABLED`, `GANGLION_DISTILL_MODEL`
(default `haiku`; the live pm2 config sets `sonnet`), `GANGLION_VAULT`.

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
Tab state is split in two, because the old single object was holding two different kinds of thing and the two front-ends raced over it (`state:save` was a blind whole-file overwrite: last writer won).

| | Lives in | Owner | Contents |
|---|---|---|---|
| **Shared** | `~/.ganglion/state.json` | the server | `id`, `name`, `cwd`, `autoName`, `markdownFile` — what a tab *is*. Both windows must agree |
| **View** | `localStorage` (`ganglion.viewState`) | each front-end | `splitPosition`, `panelMode`, `activeTabId` — how *this* window is looking at it. Two windows disagreeing is correct, not a conflict |

Split that way there is nothing left to reconcile — no merge protocol, no last-writer-wins. Clients send per-tab mutations (`tab:created` / `tab:updated` / `tab:closed`); the server applies each to the shared state, persists it, and rebroadcasts to **every** client including the sender. Re-applying a mutation is a no-op, so the sender handles its own echo through the same path it handles the other window's changes.

The rule lives once, in `lib/tab-state.js`, which the server requires and the browser loads over the `/tab-state.js` route — the two sides cannot disagree about which fields are per-client. Legacy state files are migrated on load: `splitTabState()` pulls the view keys out and drops them.

Consequences: a tab opened, renamed, or closed in one window now appears in the other **without a reload**, and dividers no longer ping-pong. Note the view half is per *browser profile*, so the Mac browser and the desktop shell keep genuinely independent layouts.

## Key Constraints
- Shells run **unelevated**; anything needing elevation must be handed to Chris as a pasteable block
- pm2 must be invoked as `node <prefix>\node_modules\pm2\bin\pm2` from an **elevated** shell — not via `pm2.cmd`, whose bare-`node` fallback fails there (see How to Run)
- Never `pm2 restart ganglion` from inside a Ganglion tab — it kills the pty running the command
- Scripts needing env vars must source `.env` explicitly
- **Ganglion refuses the application's request for the mouse.** Claude Code sends `CSI ? 1000/1002/1003 h`; `refuseMouseReporting()` swallows it, so tracking is never enabled and a plain drag always selects. The cost is deliberate: clicks inside Claude's UI don't register, and the wheel scrolls xterm's scrollback rather than Claude's view. Selected text is copied automatically — no Ctrl+C needed. See `docs/Codebase-Map.md`
- **No auth anywhere.** `GET /file?path=` reads any path the server user can, and the listener binds all interfaces by default — which is exactly what the Mac depends on, so this cannot simply be bound to loopback. Accepted risk; do not expose port 3000 to an untrusted network. `GANGLION_HOST` allows pinning the interface later without a code change.
- `pty:cwd` on Windows comes from the **shell**, not the OS. Windows exposes no readable per-process cwd, so `cwdProbe()` still returns null there; instead `shellArgs()` installs a prompt wrapper that emits OSC 7 and the server reads it back off the pty stream (`lib/osc7.js`). Consequences: the cwd only advances when a **prompt is drawn** (a tab sitting inside a long-running `claude` reports the directory it last prompted in), and a shell spawned *inside* the pty is not wrapped. The renderer polls `pty:cwd` every 5s, so a `cd` renames the tab within ~5s
