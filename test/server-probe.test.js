'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { serverPort, serverUrl, probeServer, waitForServer } = require('../lib/server-probe');

// The desktop client attaches to an already-running server (pm2 owns it) rather than
// spawning one. So before it points a BrowserWindow at the port it has to answer one
// question -- "is something serving there?" -- and answer it without ever throwing, since
// "not running yet" is an ordinary state, not an error.
//
// These tests use a real http server on an ephemeral port (listen(0)) rather than mocking
// http.get: the whole value of this module is that it behaves correctly against real
// sockets, including the refused-connection and never-answers cases.

/** Start a throwaway server and resolve its base URL. */
function withServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/** Find a port with nothing on it, by opening one and immediately closing it. */
function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// --- serverPort / serverUrl -----------------------------------------------------------
// server.js reads the same helper, so the server and the desktop client cannot drift
// apart on the default port -- a drift that would show up only as a desktop window that
// never finds a server everyone else can see.

test('serverPort defaults to 3000', () => {
  assert.strictEqual(serverPort({}), 3000);
});

test('serverPort honours PORT', () => {
  assert.strictEqual(serverPort({ PORT: '4200' }), 4200);
});

test('serverPort returns a number even though env values are strings', () => {
  assert.strictEqual(typeof serverPort({ PORT: '4200' }), 'number');
});

test('serverPort falls back to the default for values that are not usable ports', () => {
  for (const PORT of ['', 'abc', '0', '-1', '70000', '80.5']) {
    assert.strictEqual(serverPort({ PORT }), 3000, `PORT=${JSON.stringify(PORT)}`);
  }
});

test('serverUrl targets the loopback literal, not the localhost name', () => {
  // 127.0.0.1 rather than localhost: on Windows the name can resolve to ::1 first and add
  // a resolver hop to every probe. It also keeps the client self-consistent, because
  // renderer/client.js derives its WebSocket from `location.host` -- whatever host we
  // load is the host the socket will use.
  assert.strictEqual(serverUrl({}), 'http://127.0.0.1:3000');
  assert.strictEqual(serverUrl({ PORT: '4200' }), 'http://127.0.0.1:4200');
});

// --- probeServer ----------------------------------------------------------------------

test('probeServer resolves true when the server answers 200', async () => {
  const s = await withServer((_req, res) => res.end('ok'));
  assert.strictEqual(await probeServer(s.url), true);
  await s.close();
});

test('probeServer treats any HTTP response, including 404, as alive', async () => {
  // The question is "is something listening and speaking HTTP", not "does this route
  // exist". Asserting on a status code would make the probe fail the moment routing
  // changes.
  const s = await withServer((_req, res) => {
    res.statusCode = 404;
    res.end('nope');
  });
  assert.strictEqual(await probeServer(s.url), true);
  await s.close();
});

test('probeServer resolves false when nothing is listening on the port', async () => {
  const port = await freePort();
  assert.strictEqual(await probeServer(`http://127.0.0.1:${port}`), false);
});

test('probeServer resolves false when the server never responds within the timeout', async () => {
  // A socket that accepts and then goes silent is the nastiest case: without an explicit
  // timeout the probe would hang and the window would never show anything at all.
  const s = await withServer(() => {
    /* deliberately never responds */
  });
  assert.strictEqual(await probeServer(s.url, { timeoutMs: 150 }), false);
  await s.close();
});

test('probeServer never rejects, even for a malformed url', async () => {
  await assert.doesNotReject(async () => {
    assert.strictEqual(await probeServer('not-a-url'), false);
  });
});

// --- waitForServer --------------------------------------------------------------------

test('waitForServer resolves immediately when the server is already up', async () => {
  const s = await withServer((_req, res) => res.end('ok'));
  await waitForServer(s.url, { intervalMs: 20 });
  await s.close();
});

test('waitForServer resolves once the port starts accepting', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const server = http.createServer((_req, res) => res.end('ok'));
  const started = new Promise((resolve) => {
    setTimeout(() => server.listen(port, '127.0.0.1', resolve), 80);
  });

  await waitForServer(url, { intervalMs: 20 });
  await started;
  await new Promise((r) => server.close(r));
});

test('waitForServer reports each failed attempt via onAttempt', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let attempts = 0;

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);

  await assert.rejects(
    () => waitForServer(url, { intervalMs: 20, signal: controller.signal, onAttempt: () => { attempts += 1; } }),
    /aborted/i
  );
  assert.ok(attempts >= 2, `expected repeated attempts, saw ${attempts}`);
});

test('waitForServer stops polling when its signal is aborted', async () => {
  const port = await freePort();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => waitForServer(`http://127.0.0.1:${port}`, { intervalMs: 20, signal: controller.signal }),
    /aborted/i
  );
});
