# Ganglion

A browser-based terminal multiplexer built for running several Claude Code sessions at once.

Ganglion is an always-on Node server on a home box. You open it from any browser on your
private network, and each tab is a real shell (`node-pty` + `xterm.js`). A coloured dot on every
tab shows what Claude Code is doing in it: working, waiting for you, or idle. Ganglion also
captures every session it hosts into a searchable SQLite memory store, next to your Obsidian vault,
so past conversations and decisions are a keyword search away.

**Why.** With several agents running in parallel, the hard part is knowing which one needs you.
tmux can't see inside Claude Code, and a laptop terminal dies when the lid closes. Ganglion keeps
the shells on a server, survives disconnects, mirrors the same live terminals to every attached
browser (tmux-style), and turns Claude Code's hook events into per-tab status and optional phone
alerts.

> **Security first:** there is **no login**. Anyone who can reach the port gets a shell as the
> service user. Run it only on a private network you control (it is built for
> [Tailscale](https://tailscale.com)), and never expose it to the internet. See
> [Security](#security).

## Features

- **Tabs** — `+` to create, `×` to close, double-click to rename; tabs auto-name after the git repo they're in
- **Right panel** — per tab: hidden, a second terminal, or a markdown viewer (type a path; rendered with GFM, sanitized)
- **Persistence** — shells keep running when every browser closes; reconnecting replays their recent output. Tab names, working directories, open markdown files and panel layout are saved to `~/.ganglion/state.json`. A server restart still ends the shells, but each tab's scrollback is saved to `~/.ganglion/scrollback/` and comes back above a fresh prompt
- **Search** — `Ctrl+Shift+F` (`Cmd+F` on a Mac) searches the focused terminal's scrollback; Enter / Shift+Enter step through matches, Esc closes
- **Status dot** — per tab, driven by Claude Code hooks in the *left* terminal:
  - 🟢 working · 🔴 waiting for you · ⚪️ idle / not running

  The right-hand terminal deliberately has no status colour.
- **Phone alerts** (optional) — a push via [ntfy](https://ntfy.sh) when a tab has been red for 30s or a long Claude run finishes, so you can walk away. Set `GANGLION_NTFY_URL` and subscribe to the topic in the ntfy app
- **Memory** — 🧠 or `Ctrl/Cmd+K`: keyword search over past Claude Code turns, per-session notes, and the Obsidian vault, with filters and click-to-expand context
- **Clipboard** — `Ctrl+Shift+C` copies the selection; copying from Claude Code (OSC 52) reaches your local clipboard; pasting an image uploads it and types its path

## Running it

Requirements: Linux (developed on Ubuntu 24.04), Node 22, build tools for the native modules (`python3 g++ make`), and Claude Code. The systemd unit assumes user `ubuntu` with the repo at `~/dev/Ganglion`; edit `deploy/ganglion.service` for another layout.

Set the host up once with `bash deploy/setup-server.sh` (idempotent: build deps, `~/.ganglion/ganglion.env`, `npm ci`, the systemd unit), then run `npm run setup-hooks` to install the Claude Code hooks. Without the hooks there are no status dots and no memory capture.

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
| `GANGLION_VAULT` | Obsidian vault to index (default `~/TheBrainOfChris`; set this to your own vault) |
| `GANGLION_ALLOWED_HOSTS` | Extra host names the browser may use to reach Ganglion |
| `GANGLION_NTFY_URL`, `GANGLION_NTFY_TOKEN`, `GANGLION_ALERT_CLICK_URL`, `GANGLION_ALERT_DELAY_SEC`, `GANGLION_ALERT_DONE_MIN` | Phone alerts: ntfy topic URL (unset = off), optional token, link the alert opens, seconds a tab must stay red/idle before alerting (30), minimum run length for a "finished" alert (5; 0 = off) |
| `GANGLION_SWEEP_SIGNALS` | Production only: clear stale tab files from `/tmp` at boot |

### Deploying

Deploys are deliberate: **a merge to `main` does not deploy.** `.github/workflows/deploy.yml` runs CI on every push and PR; the deploy job runs only on a `v*` tag or a manual `workflow_dispatch`. It joins the tailnet as an ephemeral node, SSHes to the box and runs `deploy/deploy.sh <ref>` (checkout → `npm ci` → `npm test` → restart → health check).

It needs repository secrets `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `DEPLOY_SSH_KEY`, `SSH_KNOWN_HOSTS` and a repository variable `DEPLOY_HOST` (the box's MagicDNS name or tailnet IP).

> ⚠️ **A restart kills every terminal**, including the one you ran it from (their scrollback is kept, the running programs are not). Deploy from a plain SSH shell, not a Ganglion tab, at a moment when losing all tabs is fine.

> ⚠️ **The checkout is live.** The service runs from its checkout (`~/dev/Ganglion`) and serves `renderer/` straight from disk, so pulling or switching branches there changes what browsers get on reload. Work in a worktree: `git worktree add ../Ganglion-<branch>`.

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

<a id="security"></a>**Security.** There is no login: anything that can reach port 3000 gets a shell as the service user, so keep it on a private network such as a tailnet, optionally with a firewall rule limiting the port to it. What *is* blocked is other websites (`lib/request-guard.js`): the `Host` header must name this box (localhost, an IP literal, its hostname, its MagicDNS name or `GANGLION_ALLOWED_HOSTS`), and a browser's `Origin` must be one of those too. That stops DNS-rebinding and cross-site WebSocket attacks from a page open in your own browser. Requests without an `Origin` (curl, the hooks) are allowed.

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
