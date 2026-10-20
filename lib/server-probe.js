'use strict';

// The port the server listens on (PORT, default 3000).

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

/**
 * Anything that is not a usable TCP port -- empty, non-numeric, fractional, out of range,
 * or 0 -- falls back to the default rather than propagating a NaN into listen().
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

module.exports = { serverPort, DEFAULT_PORT };
