# Ganglion — Project Context for Claude Code

> **Codebase Map:** see `docs/Codebase-Map.md` for the repo orientation layer (data flows, invariants, component + DB tables). Read it first when navigating the code.

## What It Is
Ganglion is a terminal multiplexer that runs as a Node.js server on this machine. Each tab pairs a real interactive shell (via `node-pty` + `xterm.js`) with a markdown viewer. Tab colors reflect Claude Code's activity state in that terminal.

Browsers attach to that one server and **mirror the same live ptys** — in practice the Mac, over Tailscale (any tailnet device can connect). Several can be connected at once.

## Where It Runs
Production is a GMKtec M6 Ultra mini PC — hostname `stigmergylabs` (`stigmergylabs.tailc44383.ts.net`, Ubuntu 24.04, 12 cores / 25 GB, headless, user `ubuntu`), repo at `/home/ubuntu/dev/Ganglion`, run by **systemd** as the `ganglion` service (`deploy/ganglion.service`). Config lives in `~/.ganglion/ganglion.env` (mode 600, `EnvironmentFile=` of the unit) — that is where `PORT`, `GANGLION_DISTILL_ENABLED`, `GANGLION_DISTILL_MODEL`, `GANGLION_CLAUDE_BIN` and `GANGLION_SWEEP_SIGNALS=1` (boot sweep of stale tab signal files; production only) are set. `setup-server.sh` only creates this file when it is missing, so a new knob in `.env.example` must be added to the live file by hand. First-time host setup: `bash deploy/setup-server.sh` (idempotent).

Earlier hosts are retired: the Dell (tailnet node `stigmergylabs-dell`, offline), before that EC2, and before that a Windows box over RDP. Comments mentioning EC2, security groups, pm2 or Windows paths are leftovers from those.

```bash
sudo systemctl status ganglion --no-pager
sudo journalctl -u ganglion -n 50 --no-pager
node server.js          # dev run from the repo
npm run setup-hooks     # install Claude Code hooks (idempotent)
npm test
```

Runs at **http://localhost:3000** by default. Override with `PORT=XXXX`. `GANGLION_HOST` pins the listen interface (defaults to `0.0.0.0`, which is what lets the Mac connect).

## Deploy
`.github/workflows/deploy.yml` runs CI on every push and PR, but **deploy is gated**: it fires only on a `v*` tag push or a manual `workflow_dispatch` — **never on a merge to `main`**. The runner joins the tailnet and SSHes in to run `deploy/deploy.sh <ref>` (checkout → `npm ci` → `npm test` → `sudo systemctl restart ganglion` → health check). With no ref it deploys the latest `v*` tag.

```bash
gh workflow run deploy.yml -f ref=main    # or: git tag vX.Y.Z && git push origin vX.Y.Z
```

Don't run that by hand from a session: deploys go through the **deploy** skill / **ops** agent in `~/dev/agent-ops` (entry `ganglion` in `ops/deployments.yaml`), and the deploy-gate hook prompts on it anyway. There are no `v*` tags yet, so deploy by SHA via dispatch.

> ⚠️ **The gate only covers restarts — the working tree is live.** The service runs straight out of `/home/ubuntu/dev/Ganglion`, and `express.static` reads `renderer/` from disk on every request. So any `git pull`, `git checkout` or edit in that repo changes what browsers get on their next reload, with no deploy at all. Server-side code (`server.js`, `lib/`, `memory/`, `db/`) only changes on a restart — including a reboot, since the unit is enabled. Do risky or in-progress work on a branch in a separate worktree/clone, not in the live checkout.

> ⚠️ **A deploy or `systemctl restart ganglion` kills every pty** — including the one running the command and any Claude Code agents in other tabs. Never trigger it from inside a Ganglion tab (check `echo $GANGLION_TAB_ID`); use a plain SSH shell, at a moment when losing all tabs is fine. See `docs/verify-session-notes-deploy.md`.

## Desktop Client (legacy)
`npm run desktop` opens an Electron window onto an **already-running** server. It was built for the old Windows-over-RDP host and is **not used on this host**: the box is headless, and the client is hardwired to `http://127.0.0.1:<PORT>` (`lib/server-probe.js`), so it only works on the same machine as the server. Pointing it at a remote host would need a URL override (not implemented). If touching it, keep its two rules:

- **It never spawns a server.** The service manager owns the lifecycle. On launch it probes the port and shows `electron/retry.html` if nothing answers, connecting automatically once the server returns.
- **It never loads a native module.** `node-pty` and `better-sqlite3` are never required from Electron — so **there is no `electron-rebuild` step**. Requiring `db/`, `memory/`, or either native module from `electron/` would break this.

Launch it as `electron electron/main.js`, never `electron .` — that resolves `package.json:main`, which is `server.js`, and would boot Express inside Electron. Window bounds persist to `~/.ganglion/window.json`; the window has no menu, so terminal keys (`Ctrl+W`, `Ctrl+T`, `Ctrl+L`, `Ctrl+R`, `F5`) reach the shell instead of browser chrome.

## Architecture

| File | Role |
|---|---|
| `server.js` | Express + WebSocket server, node-pty lifecycle, state persistence, status file watchers |
| `renderer/index.html` | App shell |
| `renderer/renderer.js` | Tab UI, xterm.js wiring, markdown rendering, divider |
| `renderer/client.js` | WebSocket client abstraction |
| `renderer/terminal-keys.js` | Shared key policy — decides pty vs browser vs app for each keydown; read by both the terminals and the Memory overlay |
| `renderer/clipboard.js` | Terminal → local clipboard: OSC 52 handler (how Claude Code copies on a headless box), Ctrl+Shift+C copy, click-to-copy fallback when the browser blocks a write; skips replayed output |
| `renderer/markdown.js` | `renderMarkdown()` — `marked` + DOMPurify; the only way markdown may reach `innerHTML` |
| `renderer/styles.css` | Styles |
| `hooks/ganglion-hooks.json` | Claude Code hook config (standalone copy) |
| `setup-hooks.js` | Merges hooks into `~/.claude/settings.json` |
| `db/schema.sql`, `db/db.js` | SQLite memory store (`~/.ganglion/memory.db`) schema + connection |
| `memory/ingest.js` | Incremental ingest of Claude Code transcript JSONL into `turns` |
| `memory/index-vault.js` | Index the Obsidian vault (`~/Documents/TheBrainOfChris`) into `documents` — that path does not exist on this host, so the server's vault watcher no-ops there |
| `memory/search.js` | Keyword recall (FTS5) over sessions + notes; two-stage retrieve/rank |
| `memory/distiller.js` | Distills one narrative session note via headless `claude -p` into `sessions.summary` |
| `lib/platform.js` | Windows/POSIX bindings: shell, signal-file paths, cwd probe, `claude` binary |
| `lib/pty-sizing.js` | Per-client size registry; pty takes the minimum over attached clients |
| `lib/request-guard.js` | Host + Origin allowlist for every HTTP request and WebSocket — stops other websites (and DNS rebinding) from driving the shells |
| `lib/message-guard.js` | Input checks for WebSocket messages (bad JSON, missing tabId, missing state) |
| `lib/distill-schedule.js` | When to write a session note: idle timer per session, soon after `SessionEnd`, skip if nothing new |
| `lib/server-probe.js` | Port resolution (shared with `server.js`) + non-throwing health probe |
| `lib/window-bounds.js` | Validates persisted desktop-window bounds against current displays |
| `electron/main.js` | Desktop shell: window, bounds, health probe/retry, file dialog, key policy |
| `electron/preload.js` | `contextBridge` surface (`isDesktop`, `openMarkdown`, `retry`) |
| `electron/retry.html` | Standalone "waiting for server" screen |
| `scripts/import-history.js` | One-time backfill: ingest all transcripts + index the vault (`npm run memory:import`) |
| `renderer/memory-panel.js` | Global "Memory" recall overlay (Ctrl/Cmd+K) |
| `test/*.test.js` | Node test-runner suite (`npm test`) |
| `test/helpers/server.js` | Integration harness: spawns a real `server.js` with its own `HOME`, `TMPDIR` and an ephemeral port (`PORT=0`) on 127.0.0.1, plus a recording WebSocket client. Used by `test/server-*.test.js`. Any hand-started test server needs the same isolation — signal files live in `os.tmpdir()`, shared with the live service |

## WebSocket Message Protocol
All messages are JSON. Key types:

| Type | Direction | Purpose |
|---|---|---|
| `state:load` | client → server | Load persisted tab state |
| `state:loaded` | server → client | Response with state + replay buffers |
| `state:save` | client → server | Persist tab state |
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
- **Distillation → session notes** — once a session goes quiet (no new turns for `GANGLION_DISTILL_IDLE_MIN`, default 10 minutes) or soon after `SessionEnd` — and only if there are turns the last run didn't cover (`sessions.distilled_turns`; `lib/distill-schedule.js`) — a distiller runs headless `claude -p`
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
`npm run memory:import`. Env knobs: `GANGLION_DISTILL_ENABLED`, `GANGLION_DISTILL_IDLE_MIN`, `GANGLION_DISTILL_MODEL`
(default `haiku`; the live `~/.ganglion/ganglion.env` sets `sonnet`, and `GANGLION_DISTILL_ENABLED=1`), `GANGLION_VAULT`
(only read by the standalone `npm run memory:index-vault` CLI; the server's watcher uses the hardcoded path).

## Session Persistence
Pty processes survive browser close/refresh. Output is buffered in memory per tab (capped at 512KB). On reconnect, the server sends a `pty:replay` message so the terminal restores history. Processes are killed on explicit `pty:kill`, and also by any server stop, restart or crash (`cleanup()` on SIGTERM) — the buffer is in memory only, so a restart loses scrollback too.

## Claude Code Status Indicators
Each pty is spawned with `GANGLION_TAB_ID=<uuid>` in its env. Claude Code hooks write status tokens to `/tmp/ganglion-<tabId>-status` and tool names to `/tmp/ganglion-<tabId>-tool`. The server watches these files with `fs.watch` and broadcasts `tab:status` / `tab:tool` events.

| Status | Color | Trigger |
|---|---|---|
| `working` | green | `UserPromptSubmit`, `PreToolUse` |
| `waiting` | red | `Notification` (needs your input) |
| `idle` | gray | `Stop`, `SessionStart`, `SessionEnd` |

Hooks are no-ops when `GANGLION_TAB_ID` is unset (running `claude` outside Ganglion).

## Other Hooks on This Machine
`~/.claude/settings.json` holds two sets of hooks, and every Claude Code session on the box runs both:

| Owner | Hook | Event / matcher | What it does |
|---|---|---|---|
| Ganglion (`npm run setup-hooks`) | `hooks/ganglion-signal.js` | every event | Tab status, tool name, ingest signal (above) |
| agent-ops (`~/dev/agent-ops/install.sh`) | `claude/hooks/deploy-gate.py` | `PreToolUse`: `Bash`, `mcp__supabase.*`, `Artifact` | Turns deploy-shaped commands into a permission prompt — including `systemctl restart ganglion` and git checkout/pull in this live checkout |
| agent-ops | `claude/hooks/on-pr-push.py` | `PostToolUse`: `Bash` | After `gh pr create` / `git push`, nudges the session to run the **pr-review-loop** skill — only for repos in `agent-ops/review/repos.txt` |

- `setup-hooks.js` replaces only entries whose command mentions `ganglion-signal` / `GANGLION_TAB_ID`, so re-running it leaves the agent-ops hooks alone. Keep it that way.
- The hook commands point at the **live checkout** (`/home/ubuntu/dev/Ganglion/hooks/ganglion-signal.js`), so an edit there takes effect in every session immediately — a bug in it breaks status and ingest everywhere. Change it in a worktree and test before merging.
- Automated PR review (`pr-review.timer` in agent-ops) only covers repos listed in `review/repos.txt`. Check that file to see whether Ganglion PRs get reviewed.

## State Persistence
Tab state (names, cwd, open markdown files, divider positions) is saved to `~/.ganglion/state.json` on every change and restored on load.

> **Known gap with two clients connected.** `state:save` is a blind whole-file overwrite, so two connected windows race: last writer wins. In practice this shows up as divider/panel positions ping-ponging (cosmetic), and — across a restart — a tab created in one window being dropped by the other's stale copy. The tab *list* is also not live-synced: a tab opened in one window does not appear in the other until reload, and closing one leaves a stale `[process exited]` tab. The planned fix splits shared tab data from per-client view state (the latter into `localStorage`), avoiding a merge protocol entirely.

## Key Constraints
- The `ubuntu` user has passwordless `sudo` (`deploy.sh` relies on it). Still confirm before any `sudo` that restarts the service or changes the host
- A second Ganglion instance (worktree, scratch HOME) shares `/tmp` with the live server. Give it its own `TMPDIR` too, and never set `GANGLION_SWEEP_SIGNALS=1` for it: deleting the live tabs' signal files silently kills their status and ingest watchers
- Do branch work in a worktree (`git worktree add ../Ganglion-<branch>`), never by switching branches in `/home/ubuntu/dev/Ganglion` — the deploy gate prompts on checkout/pull there
- Never `systemctl restart ganglion` or trigger a deploy from inside a Ganglion tab — it kills every pty, including the one running the command (see Deploy)
- Scripts needing env vars must source `.env` explicitly
- **No auth anywhere.** `GET /file?path=` reads any path the server user can, and the listener binds all interfaces by default — which is exactly what the Mac depends on, so this cannot simply be bound to loopback. Accepted risk; do not expose port 3000 to an untrusted network. `GANGLION_HOST` allows pinning the interface later without a code change.
- **No auth does not mean any website may connect.** `lib/request-guard.js` refuses requests whose `Host` isn't this box (localhost, an IP, the hostname, or `<hostname>.<tailnet>.ts.net`) and browser requests whose `Origin` is another site; the WebSocket gets the same check via `verifyClient`. Reaching Ganglion under another name (e.g. a Mac `/etc/hosts` alias) needs `GANGLION_ALLOWED_HOSTS=name1,name2` in `ganglion.env`.
- Render markdown only through `renderMarkdown()` (`renderer/markdown.js`), never `marked.parse()` into `innerHTML` — transcripts contain web text, and script on this page can type into a shell.
- `handleMessage` catches everything a message handler throws: an uncaught throw would exit the process and kill every pty.
- `pty:cwd` uses `lsof -d cwd` on Linux (`lib/platform.js`). It is inert on Windows (no probe), where tab cwd and git-repo auto-naming do not update
