# Ganglion

A tabbed macOS desktop app — each tab pairs a real terminal with a markdown viewer, and tab colors reflect Claude Code's state in that terminal.

## Features

- **Tabs** — horizontally scrolling tab bar, `+` to create, `×` to close, double-click title to rename
- **Terminal pane (left)** — real interactive shell via `node-pty` + `xterm.js`, spawned in `$HOME`
- **Document pane (right)** — native "Open File…" picker, renders `.md`/`.markdown` with GFM formatting (headers, bold, italics, code, tables, blockquotes)
- **Draggable divider** — resize the split, per-tab, persisted
- **Full persistence** — tabs, names, working directories, open markdown files, and divider positions are restored on relaunch
- **Status indicator** — colored dot per tab driven by Claude Code hooks:
  - 🟢 green — Claude Code is working
  - 🔴 red — Claude Code is waiting for your input
  - ⚪️ gray — Claude Code is not running

## Install & Run

Requires Node 18+, macOS, and Xcode Command Line Tools (for building `node-pty`).

```bash
cd /Users/chrismurphy/Dev/Ganglion
npm install          # also runs electron-rebuild for node-pty
npm run setup-hooks  # installs Claude Code hooks into ~/.claude/settings.json
npm start
```

`npm run setup-hooks` merges Ganglion's hook config into your existing `~/.claude/settings.json` (backing it up first). It is idempotent — running it again replaces the Ganglion entries rather than duplicating them.

To verify the hooks are working: launch the app, start `claude` in a tab, send a prompt — the tab dot should turn green while it works and red when it finishes.

## How the status indicator works

Each terminal tab is spawned with `GANGLION_TAB_ID=<uuid>` in its environment. The installed Claude Code hooks write a status token (`working` / `waiting` / `idle`) to `/tmp/ganglion-$GANGLION_TAB_ID-status` on each lifecycle event. The Electron main process watches these files with `fs.watch` and pushes updates into the renderer, which recolors the tab dot.

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

Persisted app state lives at `~/Library/Application Support/ganglion/state.json`.

## Project layout

```
Ganglion/
├── main.js              # Electron main process + node-pty + status file watchers
├── preload.js           # contextBridge API exposed to the renderer
├── renderer/
│   ├── index.html
│   ├── renderer.js      # Tab UI, xterm.js wiring, marked rendering, divider
│   └── styles.css
├── hooks/
│   └── ganglion-hooks.json  # Claude Code hook config (standalone)
├── setup-hooks.js       # Merges hooks into ~/.claude/settings.json
└── package.json
```

## Not in v1

- Keyboard shortcuts
- Editing markdown (viewer is read-only)
