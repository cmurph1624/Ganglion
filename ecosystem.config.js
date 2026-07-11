// pm2 process definition for Ganglion.
//
// Start (from the runtime dir, e.g. ~/Ganglion):
//   ~/.npm-global/bin/pm2 start ecosystem.config.js
//   ~/.npm-global/bin/pm2 save
//
// The distiller (headless `claude -p` that maintains native memory/*.md files) is
// opt-in and enabled here via GANGLION_DISTILL_ENABLED. It only rewrites files it
// authored (stamped `authoredBy: ganglion`), backs every write up to
// ~/.ganglion/memory-backups/, and never clobbers user-authored memory. Set
// GANGLION_DISTILL_ENABLED to '0' (or remove it) to turn distillation back off.
module.exports = {
  apps: [
    {
      name: 'ganglion',
      script: './server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        GANGLION_DISTILL_ENABLED: '1',
        GANGLION_DISTILL_MODEL: 'haiku',
      },
    },
  ],
};
