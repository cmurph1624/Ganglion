'use strict';

// Where the Ganglion server lives, and whether it is actually there.
//
// The desktop client does not own the server -- pm2 does. So on launch it has to attach to
// something already running, which means answering "is anything serving on that port?"
// before pointing a BrowserWindow at it. "Not running yet" is an ordinary state (pm2 may
// still be starting, or the user may have stopped it), so nothing here throws for it.
//
// server.js reads serverPort() too. That is the point: if the server and the desktop
// client each had their own idea of the default port, the failure would surface only as a
// desktop window that never finds a server the browser can see perfectly well.

const http = require('node:http');

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

/**
 * The port the server listens on.
 *
 * Anything that is not a usable TCP port -- empty, non-numeric, fractional, out of range,
 * or 0 (which would mean "pick one for me", useless to a client that must guess) -- falls
 * back to the default rather than propagating a NaN into listen().
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {number}
 */
function serverPort(env = process.env) {
  const raw = env.PORT;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PORT) return DEFAULT_PORT;
  return n;
}

/**
 * The base URL the desktop client should load.
 *
 * The loopback literal, not the `localhost` name: on Windows `localhost` can resolve to
 * ::1 first and add a resolver round-trip to every probe. It also keeps the client
 * self-consistent -- renderer/client.js builds its WebSocket from `location.host`, so
 * whatever host is loaded here is the host the socket connects back to.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
function serverUrl(env = process.env) {
  return `http://127.0.0.1:${serverPort(env)}`;
}

/**
 * Is something serving HTTP at this URL?
 *
 * Any HTTP response counts, including 404 -- the question is whether a server is up, not
 * whether a particular route exists, and asserting on a status code would break the probe
 * the next time routing changes.
 *
 * Never rejects. A refused connection, a DNS failure, a malformed URL and a socket that
 * accepts then goes silent all resolve false, because to the caller they are the same
 * thing: not ready yet.
 *
 * @param {string} url
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
function probeServer(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result, req) => {
      if (settled) return;
      settled = true;
      if (req) req.destroy();
      resolve(result);
    };

    let req;
    try {
      req = http.get(url, (res) => {
        // Drain rather than parse: we only needed the response line. Leaving the body
        // unread would keep the socket alive and leak an agent slot.
        res.resume();
        finish(true, req);
      });
    } catch {
      // http.get throws synchronously on an unparseable URL.
      resolve(false);
      return;
    }

    req.setTimeout(timeoutMs, () => finish(false, req));
    req.on('error', () => finish(false, req));
  });
}

/**
 * Poll until the server answers.
 *
 * Rejects only if the caller aborts -- there is no attempt limit, because the intended use
 * is a retry screen that should keep waiting for as long as the window is open.
 *
 * @param {string} url
 * @param {{intervalMs?: number, timeoutMs?: number, signal?: AbortSignal,
 *          onAttempt?: (n: number) => void}} [options]
 * @returns {Promise<void>}
 */
async function waitForServer(url, { intervalMs = 2000, timeoutMs = 1500, signal, onAttempt } = {}) {
  let attempt = 0;
  for (;;) {
    if (signal && signal.aborted) throw new Error('waitForServer aborted');

    attempt += 1;
    if (await probeServer(url, { timeoutMs })) return;
    if (onAttempt) onAttempt(attempt);

    if (signal && signal.aborted) throw new Error('waitForServer aborted');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { serverPort, serverUrl, probeServer, waitForServer, DEFAULT_PORT };
