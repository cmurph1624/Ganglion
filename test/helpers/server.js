'use strict';
// Integration-test harness: runs a real server.js as a child process, fully isolated.
//
// Isolation is not optional. Signal files live in os.tmpdir() and state/memory live under
// $HOME/.ganglion, so an instance sharing either with the production server would read
// (and delete) the live tabs' signal files or overwrite state.json. Every instance gets
// its own HOME and TMPDIR under a fresh temp dir, an ephemeral port on loopback, and no
// distillation. stop() kills the server and removes the temp dir.
//
// Not a test file itself: it lives under test/ so `node --test` loads it, but it
// declares no tests.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const SERVER_JS = path.join(__dirname, '..', '..', 'server.js');
const DEFAULT_TIMEOUT = 8000;

function isolatedEnv(home, tmp) {
  const env = { ...process.env };
  // Anything that would make the child behave like (or interfere with) production.
  for (const k of Object.keys(env)) if (k.startsWith('GANGLION_')) delete env[k];
  delete env.PORT;
  return {
    ...env,
    HOME: home,
    TMPDIR: tmp,
    PORT: '0',
    GANGLION_HOST: '127.0.0.1',
    SHELL: '/bin/bash',
  };
}

/**
 * Start an isolated server. Resolves once it logs its bound port.
 * @returns {Promise<{port:number, url:string, base:string, home:string, tmp:string,
 *   connect:(opts?:object)=>Promise<Client>, request:(opts?:object)=>Promise<{status:number, body:string}>,
 *   stop:()=>Promise<void>, output:()=>string}>}
 */
// env: extra variables for this instance (e.g. GANGLION_NTFY_URL pointed at a local sink),
// applied after the isolation defaults.
// home: reuse an existing HOME (to restart "the same" server); the caller owns and removes it.
async function startServer({ timeoutMs = 15000, env = {}, home: sharedHome } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-server-'));
  const home = sharedHome || path.join(base, 'home');
  const tmp = path.join(base, 'tmp');
  if (!sharedHome) fs.mkdirSync(home);
  fs.mkdirSync(tmp);

  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...isolatedEnv(home, tmp), ...env },
    cwd: base,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const clients = new Set();

  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), timeoutMs);
      const onData = () => {
        const m = /Ganglion running at http:\/\/localhost:(\d+)/.exec(log);
        if (m) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(Number(m[1]));
        }
      };
      child.stdout.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early (${code}):\n${log}`));
      });
    });
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    fs.rmSync(base, { recursive: true, force: true });
    throw err;
  }
  const url = `http://127.0.0.1:${port}`;

  async function connect({ origin, headers } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin, headers });
    const client = wrap(ws);
    clients.add(client);
    await client.opened;
    return client;
  }

  function request({ path: p = '/', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const c of clients) c.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); // server.js cleanup(): kills its ptys, then exits
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(base, { recursive: true, force: true });
  }

  return { port, url, base, home, tmp, connect, request, stop, output: () => log, pid: child.pid };
}

/** WebSocket wrapper that records every message so tests can wait on them. */
function wrap(ws) {
  const messages = [];
  const waiters = new Set();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    messages.push(msg);
    for (const w of [...waiters]) w.check();
  });
  ws.on('error', () => {});
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

  // Resolve with the first message (from index `since`) matching pred.
  function waitFor(pred, { timeoutMs = DEFAULT_TIMEOUT, since = 0, what = 'message' } = {}) {
    return new Promise((resolve, reject) => {
      let i = since;
      const w = {
        check() {
          for (; i < messages.length; i++) {
            if (pred(messages[i])) {
              cleanup();
              resolve(messages[i]);
              return;
            }
          }
        },
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
      }, timeoutMs);
      function cleanup() { clearTimeout(timer); waiters.delete(w); }
      waiters.add(w);
      w.check();
    });
  }

  // All pty:data (and pty:replay) text for one tab, concatenated.
  function output(tabId, since = 0) {
    return messages
      .slice(since)
      .filter((m) => (m.type === 'pty:data' || m.type === 'pty:replay') && m.tabId === tabId)
      .map((m) => m.data)
      .join('');
  }

  function waitForOutput(tabId, needle, { timeoutMs = DEFAULT_TIMEOUT, since = 0 } = {}) {
    const test = typeof needle === 'string' ? (s) => s.includes(needle) : (s) => needle.test(s);
    return waitFor(() => test(output(tabId, since)), { timeoutMs, since, what: `output ${needle} on ${tabId}` })
      .then(() => output(tabId, since));
  }

  let seq = 0;
  // Send a reqId-carrying request and wait for its `<type>:result` (or a given type).
  function call(type, fields = {}, { reply = `${type}:result`, timeoutMs } = {}) {
    const reqId = `r${++seq}-${Date.now()}`;
    const since = messages.length;
    send({ type, reqId, ...fields });
    return waitFor((m) => m.type === reply && m.reqId === reqId, { timeoutMs, since, what: reply });
  }

  function send(obj) {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  function close() {
    try { ws.terminate(); } catch {}
  }

  return { ws, messages, opened, waitFor, output, waitForOutput, call, send, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy, or throw. */
async function until(fn, { timeoutMs = DEFAULT_TIMEOUT, intervalMs = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

module.exports = { startServer, sleep, until };
