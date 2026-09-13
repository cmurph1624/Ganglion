#!/usr/bin/env bash
#
# One-time (idempotent) bootstrap for Ganglion on Ubuntu 24.04 (EC2).
# Run it from the repo root ON THE SERVER, after cloning:
#
#   git clone git@github.com:cmurph1624/Ganglion.git ~/dev/Ganglion
#   cd ~/dev/Ganglion
#   bash deploy/setup-server.sh
#
# It installs build deps, prepares ~/.ganglion (state dir + env file), builds the
# native modules, and installs + enables the systemd unit. It does NOT fill secrets
# or add the CI deploy key — those are printed as next steps at the end.
#
# The counterpart to the sibling claude-cron-jobs/deploy/setup-server.sh:
# reproducible host setup, version-controlled in the repo.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "== ganglion server setup =="
echo "repo: $REPO"
echo "user: $(whoami)   home: $HOME"
echo

# --- timezone (match the rest of the fleet) -----------------------------------
echo "-- timezone -> America/Denver"
sudo timedatectl set-timezone America/Denver

# --- base + native build deps (node-pty & better-sqlite3 compile from source) -
echo "-- apt packages"
sudo apt-get update -y
sudo apt-get install -y build-essential python3 g++ make curl git ca-certificates

# --- Node sanity (expect NodeSource Node 22, already installed by the fleet) ---
if command -v node >/dev/null 2>&1; then
  echo "-- node $(node --version) at $(command -v node)"
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 22 ]; then
    echo "!! Node < 22 — install Node 22 (NodeSource) before continuing" >&2
    exit 1
  fi
else
  echo "!! node not found — install Node 22 (NodeSource) first" >&2
  exit 1
fi
# The unit hardcodes ExecStart=/usr/bin/node; warn if this box differs.
if [ "$(command -v node)" != "/usr/bin/node" ]; then
  echo "!! WARNING: node is at $(command -v node), not /usr/bin/node."
  echo "   Update ExecStart in deploy/ganglion.service to match before enabling."
fi

# --- state dir (memory.db + state.json live here, OUTSIDE the repo) -----------
mkdir -p "$HOME/.ganglion"

# --- environment file (mode 600, hand-filled) ---------------------------------
ENVFILE="$HOME/.ganglion/ganglion.env"
if [ -f "$ENVFILE" ]; then
  echo "-- $ENVFILE already exists, leaving it alone"
else
  cp "$REPO/.env.example" "$ENVFILE"
  chmod 600 "$ENVFILE"
  echo "-- created $ENVFILE (mode 600) — review it"
fi

# --- native modules -----------------------------------------------------------
echo "-- npm ci (builds node-pty + better-sqlite3 for this box)"
npm ci

# --- systemd unit -------------------------------------------------------------
echo "-- installing systemd unit"
sudo cp "$REPO/deploy/ganglion.service" /etc/systemd/system/ganglion.service
sudo systemctl daemon-reload
sudo systemctl enable --now ganglion

# --- OPTIONAL host firewall (defense-in-depth) --------------------------------
# The SG already blocks :3000 publicly, and server.js binds 0.0.0.0 (cannot be
# pinned to the tailnet IP without a code change), so this ufw block restricts
# :3000 to the tailnet only. ORDER MATTERS: allow SSH FIRST or you lock yourself
# out. Uncomment to apply.
#
# sudo ufw allow 22/tcp
# sudo ufw allow in on tailscale0 to any port 3000 proto tcp
# sudo ufw --force enable

cat <<EOF

== setup done. Remaining steps ==

1. Review/fill the env file (mode 600):
     nano $ENVFILE

2. Add the CI deploy PUBLIC key to authorized_keys (private half is the
   DEPLOY_SSH_KEY GitHub secret):
     cat >> ~/.ssh/authorized_keys   # paste the ci key, then Ctrl-D

3. Verify locally:
     sudo systemctl status ganglion --no-pager
     curl -fsS http://127.0.0.1:3000/ >/dev/null && echo OK

4. Verify tailnet-only exposure:
     # reachable over tailnet (from your laptop):
     curl -sS http://100.69.175.66:3000/ | head
     # NOT reachable publicly:
     nc -vz 3.138.201.77 3000    # should fail/timeout

5. Tailscale + GitHub: tag this box tag:server, add the tag:ci -> tag:server:22
   ACL, create the OAuth client, add the GitHub Actions secrets, then push a v*
   tag (or run the workflow manually) to deploy.
EOF
