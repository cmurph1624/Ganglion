'use strict';

// The WRITER half of the Ganglion signal handshake.
//
// Claude Code hooks call this; server.js reads and watches what it produces. Both halves
// resolve their paths through lib/platform's signalFileFor(), so they cannot disagree about
// where the files live. That matters more than it looks: if the two sides ever pointed at
// different directories, Ganglion would still boot, tabs would still work, and status dots
// would simply never update while no session was ever ingested -- with no error anywhere.

const { signalFileFor } = require('./platform');

/**
 * Pure description of the files a hook event should write.
 *
 * Returning a plan rather than performing the writes keeps every branch testable without
 * touching the filesystem.
 *
 * @param {string} event Hook event name (SessionStart, PreToolUse, Stop, ...)
 * @param {object} [payload] Parsed hook JSON from stdin
 * @param {Record<string,string|undefined>} [env]
 * @returns {Array<{file: string, contents: string}>}
 */
function signalWrites(event, payload = {}, env = process.env) {
  const tabId = env.GANGLION_TAB_ID;
  // Running `claude` outside Ganglion must be completely inert.
  if (!tabId) return [];

  const status = (contents) => ({ file: signalFileFor(tabId, 'status'), contents });
  const tool = (contents) => ({ file: signalFileFor(tabId, 'tool'), contents });

  switch (event) {
    case 'SessionStart':
      return [status('idle')];

    case 'UserPromptSubmit':
      return [status('working')];

    case 'Notification':
      return [status('waiting')];

    case 'PreToolUse':
      return [tool(payload.tool_name || ''), status('working')];

    case 'PostToolUse':
      // Deliberately leaves status alone: the turn is still in progress.
      return [tool('')];

    case 'Stop':
    case 'SessionEnd': {
      const writes = [status('idle'), tool('')];
      // Recursion guard: the distiller shells out to `claude -p`, and if that subprocess
      // emitted an ingest signal it would ingest itself, then distil that, forever.
      if (!env.GANGLION_DISTILL) {
        writes.push({
          file: signalFileFor(tabId, 'ingest'),
          contents: JSON.stringify({
            session_id: payload.session_id,
            transcript_path: payload.transcript_path,
            cwd: payload.cwd,
            event: payload.hook_event_name || event
          })
        });
      }
      return writes;
    }

    default:
      return [];
  }
}

module.exports = { signalWrites };
