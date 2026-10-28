#!/usr/bin/env bash
#
# Redeploy Ganglion on the host: sync to a git ref, rebuild native modules,
# restart the service, health-check the port. Invoked by CI over SSH:
#
#   ssh ubuntu@<tailnet-ip> "bash /home/ubuntu/dev/Ganglion/deploy/deploy.sh '<ref>'"
#
# Usage: deploy.sh [git-ref]     (blank ref => latest v* tag on the box)
#
# ~/.ganglion (memory.db + state.json) lives OUTSIDE the repo, so git checkout
# and npm ci never touch it — the memory store survives every redeploy.

set -euo pipefail

REPO="/home/ubuntu/dev/Ganglion"
PORT="${PORT:-3000}"
cd "$REPO"

REF="${1:-}"
echo "== ganglion deploy =="
git fetch --all --tags --prune
if [ -z "$REF" ]; then
  REF="$(git describe --tags --abbrev=0)"
  echo "-- no ref given; deploying latest tag: $REF"
fi

echo "-- checkout $REF"
git checkout --force "$REF"

# Clean, lockfile-driven install. Wipes node_modules and rebuilds node-pty +
# better-sqlite3 against this box's Node 22 / Linux ABI. NEVER ship a foreign
# node_modules (it's gitignored anyway).
echo "-- npm ci (rebuilds native modules)"
npm ci

# Fast smoke test on the freshly-built natives (node --test, in-memory DB, no
# real claude call). Set SKIP_TESTS=1 to bypass.
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "-- npm test"
  npm test
fi

echo "-- restart service"
sudo systemctl restart ganglion

echo "-- health check http://127.0.0.1:$PORT/"
for i in $(seq 1 15); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "   healthy after ${i}s"
    git --no-pager log -1 --oneline
    exit 0
  fi
  sleep 1
done

echo "!! health check FAILED"
sudo systemctl status ganglion --no-pager || true
sudo journalctl -u ganglion -n 60 --no-pager || true
exit 1
