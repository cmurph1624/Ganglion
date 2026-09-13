// pm2 process definition for Ganglion.
//
// Start (from the runtime dir, e.g. ~/dev/Ganglion):
//   ~/.npm-global/bin/pm2 start ecosystem.config.js
//   ~/.npm-global/bin/pm2 save
//
// The distiller (headless `claude -p`) is opt-in and enabled here via
// GANGLION_DISTILL_ENABLED. As of 2026-07-22 it writes a per-session narrative note
// into sessions.summary (searchable in the Memory overlay under "Session notes"). It
// does NOT touch Claude Code's native memory/*.md files — native auto-memory solely
// owns durable/injected facts. Set GANGLION_DISTILL_ENABLED to '0' to turn it off.
module.exports = {
  apps: [
    {
      name: 'ganglion',
      script: './server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        // Distiller repointed to DB-backed session notes (no native-memory collision).
        GANGLION_DISTILL_ENABLED: '1',
        GANGLION_DISTILL_MODEL: 'sonnet',
      },
    },
  ],
};
