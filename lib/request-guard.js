'use strict';
// Who may talk to the server. Ganglion has no auth (accepted risk: tailnet only), but
// that only covers *other machines*. A webpage open in your own browser is a different
// threat: it can open a WebSocket to the tailnet IP (CORS does not apply to WebSockets)
// and type into a shell, or use DNS rebinding to read /file. Two checks stop that:
//
//   Host   — must name this box (localhost, an IP literal, the hostname, or its
//            MagicDNS name). A rebinding attack arrives with the attacker's domain.
//   Origin — when a browser sends one, it must be one of those same hosts. A page on
//            another site always sends its own origin, so it is refused.
//
// Requests with no Origin (curl, scripts, the hook) are allowed: they are not a
// browser being steered by a webpage, and the no-auth risk already covers them.

const net = require('net');
const os = require('os');

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  // A bare IPv6 address has several colons and no port.
  if (h.split(':').length > 2) return h;
  return h.split(':')[0];
}

function buildAllowedHosts({ hostname = os.hostname(), extra = process.env.GANGLION_ALLOWED_HOSTS } = {}) {
  const exact = new Set(['localhost']);
  const short = String(hostname || '').toLowerCase();
  if (short) exact.add(short);
  for (const h of String(extra || '').split(',')) {
    const t = h.trim().toLowerCase();
    if (t) exact.add(t);
  }
  // <hostname>.<tailnet>.ts.net — Tailscale's MagicDNS name for this machine.
  const magic = short
    ? new RegExp(`^${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-z0-9-]+\\.ts\\.net$`)
    : null;
  return { exact, magic };
}

function isAllowedHostname(name, allowed) {
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (allowed.exact.has(name)) return true;
  return !!(allowed.magic && allowed.magic.test(name));
}

function isAllowedHost(hostHeader, allowed) {
  return isAllowedHostname(hostnameOf(hostHeader), allowed);
}

function isAllowedOrigin(origin, allowed) {
  if (origin === undefined) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isAllowedHostname(hostnameOf(url.host), allowed);
}

// Express middleware: refuse requests addressed to a foreign Host, and cross-site
// browser requests from a foreign Origin.
function httpGuard(allowed) {
  return (req, res, next) => {
    if (!isAllowedHost(req.headers.host, allowed) || !isAllowedOrigin(req.headers.origin, allowed)) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    next();
  };
}

// ws `verifyClient` callback.
function wsVerifier(allowed) {
  return ({ req }) =>
    isAllowedHost(req.headers.host, allowed) && isAllowedOrigin(req.headers.origin, allowed);
}

module.exports = {
  hostnameOf,
  buildAllowedHosts,
  isAllowedHost,
  isAllowedOrigin,
  httpGuard,
  wsVerifier,
};
