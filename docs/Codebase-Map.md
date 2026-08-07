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
| Tab cwd / auto-name | shell prompt emits OSC 7 → `p.onData`; renderer polls WS `pty:cwd` every 5s | `spawnPty` (tracker), `handleMessage` (`pty:cwd`, `pty:reponame`) | `lib/osc7.js`; `lib/platform.js` (`shellArgs`, `cwdProbe`) | in-mem per tab → `state.json` |
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
- **The OSC 7 wire format is a two-language handshake** — `shellInitScript()` (PowerShell) writes
  it and `lib/osc7.js` (JS) reads it, and they only meet at runtime inside a pty. Windows has no
  readable per-process cwd, so this is the *only* cwd source there; break either side and tab
  names silently freeze with nothing in the logs. `test/platform.test.js` pins the format from
  both ends. The wrapper must also keep calling through to the profile's own `prompt`.
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
- **One key, one owner** — `renderer/terminal-keys.js` decides whether a keydown belongs to the
  pty, the browser, or the app; `renderer.js` and `memory-panel.js` both ask it rather than
  testing modifiers themselves. When they disagreed, Ctrl+K fired twice (xterm wrote `^K` to the
  pty *and* the overlay opened) — and `preventDefault` cannot undo that, since it does not stop
  propagation and xterm has already acted. Add an app shortcut in that module, not at a call site.
- **Ctrl+C is copy-or-interrupt, and the terminal does the copying** — with a (non-whitespace)
  selection it copies and the selection is cleared so the *next* Ctrl+C is SIGINT again; with no
  selection it is SIGINT. Ctrl+Shift+C always copies. The copy cannot be delegated to the browser:
  xterm keeps its selection in its own model rather than as a DOM selection, so there is usually
  nothing native to copy — and the generic control-key branch `preventDefault`s the chord anyway,
  which is why Ctrl+C could previously only ever interrupt. Whether a selection exists is passed
  *into* the policy (`classifyTerminalKey(e, {hasSelection})`) so the module stays pure; when it is
  ambiguous, SIGINT wins, because swallowing an interrupt is worse than an unwanted one.
- **Ganglion declines the application's request for the mouse** — Claude Code sends
  `CSI ? 1000/1002/1003 h`, and a terminal that grants it forwards every mouse event to the app,
  so a plain drag selects *nothing*. That is the protocol working correctly, and `shouldForceSelection()`
  (Shift on non-Mac, Option+`macOptionClickForcesSelection` on Mac) is the conventional escape
  hatch — but it is the wrong trade here, where the daily act is dragging text out of a terminal
  you are watching Claude work in. `refuseMouseReporting()` swallows the enable sequence via
  `parser.registerCsiHandler({prefix:'?', final:'h'})`, so tracking is never turned on and a plain
  drag always selects. Deliberately **not** the encoding modes (1005/1006/1015/1016): with tracking
  off nothing is ever sent, whichever spelling was negotiated. Only `h` is intercepted, so a real
  `l` still reaches xterm. A sequence mixing a mouse mode with a real one (`?1049;1002h` — alt
  screen *plus* tracking) is passed through untouched, because a handler consumes all of a
  sequence or none of it, and losing the alt-screen switch would corrupt the display. **Registered
  before `pty:spawn`**, or the first prompt turns tracking on before anyone is listening.
  The cost, accepted knowingly: clicks inside Claude's own UI no longer register, and the wheel
  drives xterm's scrollback instead of Claude's view. This is the piece that had made the whole
  copy path look broken — the bindings worked and faithfully copied an empty selection.
- **Selecting is the copy** — `attachCopyOnSelection()` puts the selection on the clipboard as
  soon as it settles, with no key press, the way Windows Terminal and PuTTY behave. It exists
  because of the entry above: once mouse tracking has forced the user to hold Shift just to
  select, requiring Ctrl+C on top of that is ceremony, and Ctrl+C is the one chord that is
  ambiguous with SIGINT. It listens to xterm's `onSelectionChange` rather than a DOM `mouseup`
  because xterm finalises a drag in a *document*-level listener, so a handler on the host element
  would race it for the last coordinate. Debounced (`SETTLE_MS`) since the event fires on every
  mousemove — kept well inside the 5s transient-activation window the execCommand fallback needs.
  It deliberately does **not** clear the selection: the highlight is the only feedback that the
  copy happened. Ctrl+C is unchanged, so it still copies-then-clears when a selection exists.
- **Clipboard writes need the execCommand fallback** — `navigator.clipboard` requires a secure
  context, and the Mac front-end reaches Ganglion as `http://<lan-ip>:3000`, which is not one. A
  copy written against the async API alone works locally and in Electron and silently does nothing
  from the Mac. `renderer/clipboard.js` covers both; verified end to end in Electron.
- **Ptys survive disconnect** — buffered + replayed on reconnect (`pty:replay`); killed only on explicit `pty:kill`.
- **Tab state is split, not merged** — shared fields (`id`, `name`, `cwd`, `autoName`,
  `markdownFile`) are server-owned in `~/.ganglion/state.json` and broadcast as per-tab
  mutations; view fields (`splitPosition`, `panelMode`, `activeTabId`) are per-front-end in
  `localStorage` and never cross the wire. The rule is `lib/tab-state.js`, loaded by both
  sides. Do not reintroduce a whole-object save: that is what made the browser and the
  desktop shell overwrite each other.
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
| `renderer/terminal-keys.js` | Pure key policy shared by the terminals and the overlay: pty vs browser vs app. Dual-loaded (`<script>` + `require`). |
| `renderer/clipboard.js` | Clipboard write with an execCommand fallback for the non-secure-context front-end. Injected deps, so testable with no DOM. |
| `renderer/terminal-copy.js` | Wires the policy + clipboard onto a live xterm. Split out of `renderer.js` so the shipped copy path can be driven without booting the app. |
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
| `lib/osc7.js` | Parses OSC 7 cwd announcements out of pty output. The only cwd source on Windows. |
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
