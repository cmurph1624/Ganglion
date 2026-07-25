# Ganglion

A browser-based terminal multiplexer with an optional desktop shell. Each tab pairs a real interactive shell with a markdown viewer, and tab colors reflect Claude Code's state in that terminal.

Ganglion runs as an always-on Node server. You reach it two ways, **at the same time if you like**:

- **Browser** — open `http://<host>:3000` from any machine that can route to it (this is how the Mac connects)
- **Desktop** — `npm run desktop` opens a native Electron window on the machine itself

Both front-ends attach to the *same* server and mirror the *same* live terminals, tmux-style. Typing in one appears in the other. The desktop shell exists because browser chrome steals terminal keys (`Ctrl+W`, `Ctrl+T`, `Ctrl+L`, `Ctrl+R`, `F5`) that a native window lets through to the shell.

## Features

- **Tabs** — horizontally scrolling tab bar, `+` to create, `×` to close, double-click title to rename
- **Terminal pane (left)** — real interactive shell via `node-pty` + `xterm.js`
- **Document pane (right)** — renders `.md`/`.markdown` with GFM formatting. Type a path in the browser; the desktop shell adds a native "Browse…" picker
- **Draggable divider** — resize the split, per-tab, persisted
- **Persistence** — tabs, names, working directories, open markdown files, and divider positions survive restarts; ptys survive browser close/refresh and are replayed on reconnect
- **Memory** — cross-session recall over past Claude Code sessions and the Obsidian vault (🧠 / `Ctrl+K`)
- **Status indicator** — colored dot per tab driven by Claude Code hooks:
  - 🟢 green — Claude Code is working
  - 🔴 red — Claude Code is waiting for your input
  - ⚪️ gray — Claude Code is not running

## Install & Run

Requires Node 18+. `node-pty` and `better-sqlite3` are native modules and build on install.

```bash
cd ~/Documents/dev/Ganglion   # C:\Users\rdpuser\Documents\Dev\Ganglion on this box
npm install
npm run setup-hooks           # installs Claude Code hooks into ~/.claude/settings.json
npm start                     # or run under pm2, below
```

`npm run setup-hooks` merges Ganglion's hook config into your existing `~/.claude/settings.json` (backing it up first). It is idempotent — running it again replaces the Ganglion entries rather than duplicating them.

Runs at **http://localhost:3000**. Override with `PORT`.

To verify the hooks are working: open a tab, start `claude`, send a prompt — the tab dot should turn green while it works and gray when it finishes.

### Under pm2 (production on this machine)

```bash
pm2 start ecosystem.config.js
pm2 save
```

On the Windows box this needs an elevated shell and must bypass the `pm2.cmd` shim — see the "How to Run" block in `CLAUDE.md` for the exact invocation.

> ⚠️ Never run `pm2 restart ganglion` from inside a Ganglion tab — it kills the pty running the command. Use a shell outside Ganglion.

### Desktop shell

```bash
npm run desktop
```

**There is no `electron-rebuild` step, and there must never be one.** The desktop client is a thin window: it opens a `BrowserWindow`, points it at the running server over HTTP, and does nothing else. It never loads `node-pty` or `better-sqlite3` — those are used only by the `node server.js` process — so there is no Electron ABI to rebuild against and no coupling between the desktop client and the server's native modules. (The original macOS build *did* need this; that is why the instruction lingered here for so long.)

The shell attaches to whatever server is already running and **never starts one** — pm2 owns the lifecycle. If nothing is listening it shows a retry screen and connects automatically as soon as the server comes back. Closing the window is exactly as harmless as closing a browser tab; ptys keep running.

For day-to-day use, make a shortcut rather than a `.bat` (which would flash a console window):

- **Target:** `…\Ganglion\node_modules\electron\dist\electron.exe`
- **Arguments:** `electron\main.js`
- **Start in:** the repo root

> If `node_modules\electron\dist\` is missing after `npm install`, the postinstall download was skipped. Run `node node_modules/electron/install.js` to fetch the binary.

## Mirroring: what two clients share

| Shared | Per-client |
|---|---|
| Tabs, terminals, and all pty output | Window size and position |
| Scrollback (replayed on connect) | — |
| Tab status / tool indicators | — |

The pty is sized to the **minimum over attached clients** (`lib/pty-sizing.js`), the same rule tmux uses — so the grid always fits inside every viewport, and the client with the smallest window is authoritative. Closing the smaller window gives the larger one its space back.

Known gap: the tab *list* is not live-synced. Opening a tab in one front-end does not make it appear in the other until reload, and closing one leaves a stale tab showing `[process exited]`.

## How the status indicator works

Each terminal tab is spawned with `GANGLION_TAB_ID=<uuid>` in its environment. The installed Claude Code hooks write a status token (`working` / `waiting` / `idle`) to `<tmp>/ganglion-$GANGLION_TAB_ID-status` on each lifecycle event — `<tmp>` being `os.tmpdir()`, i.e. `%TEMP%` on Windows and `/tmp` on POSIX, resolved in `lib/platform.js` so the hooks and the server cannot disagree. The server watches these files with `fs.watch` and broadcasts updates to every connected client, which recolor the tab dot.

Hook → state mapping:

| Event               | Status   |
|---------------------|----------|
| `SessionStart`      | idle     |
| `UserPromptSubmit`  | working  |
| `PreToolUse`        | working  |
| `Notification`      | waiting  |
| `Stop`              | idle     |
| `SessionEnd`        | idle     |

`Notification` is the only event that turns the dot red — Claude Code emits it specifically when it needs your attention (permission prompts, or the idle notification after ~60s of no input). When Claude finishes a turn normally (`Stop`), the dot goes back to gray.

The hook commands are guarded — if `GANGLION_TAB_ID` is unset (i.e. you're running `claude` outside Ganglion), the hook is a silent no-op.

## State location

| What | Where |
|---|---|
| Tab state | `~/.ganglion/state.json` |
| Memory store | `~/.ganglion/memory.db` |
| Desktop window bounds | `~/.ganglion/window.json` |

## Project layout

```
Ganglion/
├── server.js            # Express + WebSocket, node-pty lifecycle, watchers, memory wiring
├── ecosystem.config.js  # pm2 app definition
├── electron/
│   ├── main.js          # Desktop shell: window, bounds, health probe, file dialog
│   ├── preload.js       # contextBridge surface (3 methods)
│   └── retry.html       # "waiting for server" screen
├── lib/
│   ├── platform.js      # Windows/POSIX bindings: shell, signal paths, cwd probe
│   ├── pty-sizing.js    # min-of-attached-clients pty sizing
│   ├── server-probe.js  # port resolution + health probe
│   ├── window-bounds.js # validation for persisted window bounds
│   └── hook-signal.js   # pure write-planning for the hook signal files
├── renderer/
│   ├── index.html
│   ├── client.js        # WebSocket client, exposes window.ganglionAPI
│   ├── renderer.js      # Tab UI, xterm.js wiring, marked rendering, divider
│   ├── memory-panel.js  # Ctrl+K recall overlay
│   └── styles.css
├── db/                  # SQLite schema + connection
├── memory/              # ingest, vault indexing, search, distiller
├── hooks/               # Claude Code hook config + signal writer
├── scripts/             # one-shot backfill/import CLIs
├── test/                # node --test suite
└── setup-hooks.js       # Merges hooks into ~/.claude/settings.json
```

## Not in v1

- Keyboard shortcuts for tab management (new/close/switch)
- Editing markdown (viewer is read-only)
- Live tab-list sync between front-ends
- Authentication — the server has none, and `GET /file?path=` will read any path the server user can. Do not expose the port to an untrusted network.
