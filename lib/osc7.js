'use strict';

// Reading a pty's working directory out of its own output stream.
//
// On POSIX the server asks the OS (`lsof -a -p <pid> -d cwd`). Windows has no equivalent --
// neither Win32_Process nor Get-Process carries a cwd, and the value lives in the process
// PEB, which Node cannot read -- so lib/platform.js returns no probe there and tab names
// were simply frozen at whatever the tab was called when it opened.
//
// The way out is the convention terminals already use for this: OSC 7. The shell announces
// its directory from its prompt as
//
//     ESC ] 7 ; file://<host>/<percent-encoded-path> BEL
//
// and whoever owns the stream reads it back. That makes the shell the source of truth
// instead of the OS, which is also more accurate -- it follows `cd` inside the shell rather
// than reporting the pty leader's process-level cwd.
//
// Two properties of a pty stream shape everything here: chunks arrive at arbitrary
// boundaries (so a sequence is routinely torn in half), and the stream is otherwise
// untrusted output that may contain anything at all.

const OSC7_PREFIX = '\x1b]7;';

// Enough for any real path, small enough that a stray unterminated OSC 7 in the output
// cannot pin the rest of the session's output in memory.
const MAX_CARRY = 4096;

/**
 * Turn an OSC 7 payload into a native filesystem path.
 *
 * Returns null for anything that is not a usable file URI, including payloads that fail to
 * decode -- this runs inside the pty data handler, so throwing here would take down output
 * forwarding for the tab.
 *
 * @param {string} uri
 * @returns {string|null}
 */
function parseOsc7Uri(uri) {
  const raw = String(uri || '');
  if (!raw.startsWith('file://')) return null;

  // Everything after the authority. `file:///path` (empty host) and `file://host/path` are
  // both legal spellings, and the host is irrelevant to us either way.
  const slash = raw.indexOf('/', 'file://'.length);
  if (slash === -1) return null;
  const encoded = raw.slice(slash);
  if (!encoded || encoded === '/') return null;

  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // Truncated or invalid escape -- garbage in the stream, not a directory.
    return null;
  }

  // A leading slash in front of a drive letter is an artifact of the URI form, not part of
  // the path. Detecting the shape rather than checking process.platform keeps this
  // deterministic: the emitter's platform is what matters, and it is the one being parsed.
  if (/^\/[A-Za-z]:/.test(decoded)) {
    return decoded.slice(1).replace(/\//g, '\\');
  }
  return decoded;
}

/**
 * A per-pty accumulator that watches output for OSC 7 and tracks the latest directory.
 *
 * push() returns the new cwd only when it actually changed, so callers can use it directly
 * as a "should I broadcast this" signal -- the prompt re-announces on every command, and
 * the overwhelming majority of those announcements say nothing new.
 *
 * @returns {{push(chunk: string): string|null, cwd: string|null, pending(): number}}
 */
function createCwdTracker() {
  let carry = '';
  let cwd = null;

  return {
    get cwd() {
      return cwd;
    },

    // Exposed for the test that pins the unbounded-growth guard.
    pending() {
      return carry.length;
    },

    push(chunk) {
      carry += String(chunk == null ? '' : chunk);

      let found = null;
      let searchFrom = 0;

      while (true) {
        const start = carry.indexOf(OSC7_PREFIX, searchFrom);
        if (start === -1) break;

        const bodyStart = start + OSC7_PREFIX.length;
        const bel = carry.indexOf('\x07', bodyStart);
        const st = carry.indexOf('\x1b\\', bodyStart);

        // Both terminators are legal; whichever comes first ends this sequence.
        let end = -1;
        let width = 0;
        if (bel !== -1 && (st === -1 || bel < st)) {
          end = bel;
          width = 1;
        } else if (st !== -1) {
          end = st;
          width = 2;
        }

        if (end === -1) {
          // Sequence is still in flight. Keep it -- and only it -- for the next chunk.
          carry = carry.slice(start);
          if (carry.length > MAX_CARRY) carry = '';
          return commit(found);
        }

        const parsed = parseOsc7Uri(carry.slice(bodyStart, end));
        if (parsed) found = parsed;
        searchFrom = end + width;
      }

      // Nothing in flight. Retain only enough of the tail to rejoin a prefix that was split
      // mid-escape (ESC, ESC], ESC]7 ...).
      carry = carry.slice(-(OSC7_PREFIX.length - 1));
      return commit(found);
    }
  };

  function commit(found) {
    if (!found || found === cwd) return null;
    cwd = found;
    return cwd;
  }
}

module.exports = { parseOsc7Uri, createCwdTracker };
