# Ganglion

A terminal multiplexer that runs as an always-on Node server and is used from a browser. Each tab is a real shell (`node-pty` + `xterm.js`) with an optional right-hand panel — a second terminal or a markdown viewer — and the tab's dot shows what Claude Code is doing in it. Ganglion also remembers: every Claude Code session it hosts is captured into a searchable memory store, alongside your Obsidian vault.

It runs on `stigmergylabs` (a GMKtec mini PC, Ubuntu 24.04) as the `ganglion` systemd service. Browsers connect over Tailscale — in practice the Mac — at `http://stigmergylabs.tailc44383.ts.net:3000`. Any number of browsers can attach at once; they mirror the same live terminals, tmux-style.

## Features

- **Tabs** — `+` to create, `×` to close, double-click to rename; tabs auto-name after the git repo they're in
- **Right panel** — per tab: hidden, a second terminal, or a markdown viewer (type a path; rendered with GFM, sanitized)
- **Persistence** — shells keep running when every browser closes; reconnecting replays their recent output. Tab names, working directories, open markdown files and panel layout are saved to `~/.ganglion/state.json`
- **Status dot** — per tab, driven by Claude Code hooks in the *left* terminal:
  - 🟢 working · 🔴 waiting for you · ⚪️ idle / not running

  The right-hand terminal deliberately has no status colour.
- **Memory** — 🧠 or `Ctrl/Cmd+K`: keyword search over past Claude Code turns, per-session notes, and the Obsidian vault, with filters and click-to-expand context
- **Clipboard** — `Ctrl+Shift+C` copies the selection; copying from Claude Code (OSC 52) reaches your local clipboard; pasting an image uploads it and types its path

## Running it

The service is set up once with `bash deploy/setup-server.sh` (idempotent: build deps, `~/.ganglion/ganglion.env`, the systemd unit, the hooks).

```bash
sudo systemctl status ganglion --no-pager
sudo journalctl -u ganglion -n 50 --no-pager
```

Configuration lives in `~/.ganglion/ganglion.env` (mode 600, read by the unit). `.env.example` documents every knob:

| Variable | Meaning |
|---|---|
| `PORT` / `GANGLION_HOST` | Listen port (3000) and interface (all) |
| `GANGLION_DISTILL_ENABLED`, `GANGLION_DISTILL_MODEL`, `GANGLION_DISTILL_IDLE_MIN` | Session notes: on/off, model, minutes of quiet before a note is written |
| `GANGLION_CLAUDE_BIN` | `claude` binary for session notes (default `~/.local/bin/claude`) |
| `GANGLION_VAULT` | Obsidian vault to index (default `~/TheBrainOfChris`) |
| `GANGLION_ALLOWED_HOSTS` | Extra host names the browser may use to reach Ganglion |
| `GANGLION_SWEEP_SIGNALS` | Production only: clear stale tab files from `/tmp` at boot |

### Deploying

Deploys are deliberate — **a merge to `main` does not deploy.** Use the agent-ops **deploy** skill (`/deploy ganglion`), which runs `.github/workflows/deploy.yml`: CI, then SSH over Tailscale to run `deploy/deploy.sh <ref>` (checkout → `npm ci` → `npm test` → restart → health check).

> ⚠️ **A restart kills every terminal**, including the one you ran it from. Deploy from a plain SSH shell, not a Ganglion tab, at a moment when losing all tabs is fine.

> ⚠️ **The checkout is live.** The service runs from `/home/ubuntu/dev/Ganglion` and serves `renderer/` straight from disk, so pulling or switching branches there changes what browsers get on reload. Work in a worktree: `git worktree add ../Ganglion-<branch>`.

### Developing

```bash
npm ci
npm test               # unit tests + server integration tests (node --test)
npm run setup-hooks    # (re)install the Claude Code hooks; leaves other hooks alone
```

To run a second instance by hand, isolate it completely — its own `HOME`, its own `TMPDIR`, another port — or it will share state and `/tmp` signal files with the live server:

```bash
HOME=$(mktemp -d) TMPDIR=$(mktemp -d) PORT=3999 GANGLION_HOST=127.0.0.1 node server.js
```

The integration tests do this for you (`test/helpers/server.js`).

## How it works

**Status.** Every shell gets `GANGLION_TAB_ID=<uuid>`. Claude Code hooks (`hooks/ganglion-signal.js`) write `working` / `waiting` / `idle` to `/tmp/ganglion-<tab>-status`; the server watches it and broadcasts to every browser. Outside Ganglion the hooks do nothing.

| Hook | Status |
|---|---|
| `UserPromptSubmit`, `PreToolUse` | working |
| `Notification` (needs your input) | waiting |
| `SessionStart`, `Stop`, `SessionEnd` | idle |

**Memory.** On `Stop`/`SessionEnd` the hooks also drop an ingest signal; the server reads the new lines of the session's transcript into `~/.ganglion/memory.db` (SQLite + FTS5). With session notes enabled, once a session has been quiet for a while (or has ended) a headless `claude -p` writes a short narrative note for it. The vault is indexed at boot and re-indexed as notes change.

**Sizing.** Each terminal is sized to the smallest viewport among the attached browsers, so it fits in all of them.

**Security.** There is no login: anything that can reach port 3000 gets a shell, so keep it on the tailnet. What *is* blocked is other websites: requests must name this host and, from a browser, come from Ganglion's own page — so a page open in your browser can't connect to the terminals.

## Known gaps

- Two browsers share one `state.json` and the last save wins; a tab opened in one doesn't appear in the other until reload.
- `GET /file?path=` reads any file the service user can (it backs the markdown viewer).

## Layout

```
server.js            Express + WebSocket server: ptys, watchers, memory wiring
lib/                 Pure helpers (sizing, request guard, message checks, schedules, sweeps, atomic writes, platform bindings)
renderer/            Browser UI: tabs, xterm.js, markdown, Ctrl+K memory overlay, key policy, clipboard
db/                  SQLite schema + connection
memory/              Transcript ingest, vault indexing, search, session-note distiller
hooks/               Claude Code hook config + signal writer
deploy/              systemd unit, setup and deploy scripts
scripts/             One-off backfill / import CLIs
test/                node --test suite
docs/                Codebase map and deploy checklists
```

See `CLAUDE.md` and `docs/Codebase-Map.md` for the detailed map, message protocol and invariants.
