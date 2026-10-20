'use strict';
// Integration: pty lifecycle over the WebSocket protocol against a real server.js process
// (see test/helpers/server.js for the isolation it runs under).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startServer, until } = require('./helpers/server');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { if (srv) await srv.stop(); });

const rand = () => crypto.randomBytes(4).toString('hex');
const newTab = () => `tab-${rand()}`;

// Ask the shell for its pid; returns it as a number. The marker is split in the command
// so the echoed input line itself can't match the regex.
async function shellPid(c, tabId) {
  const tag = rand();
  const since = c.messages.length;
  c.send({ type: 'pty:write', tabId, data: `echo "pid-${tag}"-$$-end\r` });
  const out = await c.waitForOutput(tabId, new RegExp(`pid-${tag}-(\\d+)-end`), { since });
  return Number(new RegExp(`pid-${tag}-(\\d+)-end`).exec(out)[1]);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('pty:spawn streams pty:data; pty:write echoes; pty:resize applies', async () => {
  const c = await srv.connect();
  const tabId = newTab();
  c.send({ type: 'pty:spawn', tabId });
  await c.waitFor((m) => m.type === 'pty:data' && m.tabId === tabId, { what: 'first pty:data' });

  const token = `hello-${rand()}`;
  c.send({ type: 'pty:write', tabId, data: `echo ${token}\r` });
  await c.waitForOutput(tabId, new RegExp(`${token}\\r?\\n`));

  c.send({ type: 'pty:resize', tabId, cols: 101, rows: 33 });
  const since = c.messages.length;
  c.send({ type: 'pty:write', tabId, data: 'stty size\r' });
  await c.waitForOutput(tabId, /33 101/, { since });

  c.send({ type: 'pty:kill', tabId });
  c.close();
});

test('pty:kill terminates the shell', async () => {
  const c = await srv.connect();
  const tabId = newTab();
  c.send({ type: 'pty:spawn', tabId });
  const pid = await shellPid(c, tabId);
  assert.ok(alive(pid));
  c.send({ type: 'pty:kill', tabId });
  await until(() => !alive(pid), { what: `shell ${pid} to die` });
  // Writes to a killed tab are dropped, and state:load replays nothing for it.
  c.send({ type: 'pty:write', tabId, data: 'echo nope\r' });
  const since = c.messages.length;
  await c.call('state:load', {}, { reply: 'state:loaded' });
  assert.strictEqual(c.messages.slice(since).some((m) => m.type === 'pty:replay' && m.tabId === tabId), false);
  c.close();
});

test('spawning the same tabId twice replays instead of starting a second shell', async () => {
  const c = await srv.connect();
  const tabId = newTab();
  c.send({ type: 'pty:spawn', tabId });
  const token = `once-${rand()}`;
  c.send({ type: 'pty:write', tabId, data: `echo ${token}\r` });
  await c.waitForOutput(tabId, new RegExp(`${token}\\r?\\n`));
  const pid1 = await shellPid(c, tabId);

  const since = c.messages.length;
  c.send({ type: 'pty:spawn', tabId });
  const replay = await c.waitFor((m) => m.type === 'pty:replay' && m.tabId === tabId, { since });
  assert.ok(replay.data.includes(token));
  const pid2 = await shellPid(c, tabId);
  assert.strictEqual(pid2, pid1);

  c.send({ type: 'pty:kill', tabId });
  await until(() => !alive(pid1), { what: 'shell to die' });
  c.close();
});

test('a second client gets pty:replay of buffered output after state:load', async () => {
  const a = await srv.connect();
  const tabId = newTab();
  a.send({ type: 'pty:spawn', tabId });
  const token = `mirror-${rand()}`;
  a.send({ type: 'pty:write', tabId, data: `echo ${token}\r` });
  await a.waitForOutput(tabId, new RegExp(`${token}\\r?\\n`));

  const b = await srv.connect();
  await b.call('state:load', {}, { reply: 'state:loaded' });
  const replay = await b.waitFor((m) => m.type === 'pty:replay' && m.tabId === tabId);
  assert.ok(replay.data.includes(token));

  // Live output is mirrored to both clients.
  const live = `live-${rand()}`;
  const sinceB = b.messages.length;
  a.send({ type: 'pty:write', tabId, data: `echo ${live}\r` });
  await b.waitForOutput(tabId, new RegExp(`${live}\\r?\\n`), { since: sinceB });

  a.send({ type: 'pty:kill', tabId });
  a.close();
  b.close();
});

const hasLsof = !spawnSync('lsof', ['-v']).error;

test('pty:cwd returns the shell cwd', { skip: !hasLsof && 'lsof not installed' }, async () => {
  const c = await srv.connect();
  const tabId = newTab();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(srv.base, 'cwd-')));
  c.send({ type: 'pty:spawn', tabId, cwd: dir });
  await c.waitFor((m) => m.type === 'pty:data' && m.tabId === tabId);
  const r = await c.call('pty:cwd', { tabId });
  assert.strictEqual(r.cwd, dir);

  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const since = c.messages.length;
  c.send({ type: 'pty:write', tabId, data: `cd sub && echo "moved"-ok\r` });
  await c.waitForOutput(tabId, /moved-ok/, { since });
  const r2 = await c.call('pty:cwd', { tabId });
  assert.strictEqual(r2.cwd, sub);

  const none = await c.call('pty:cwd', { tabId: 'no-such-tab' });
  assert.strictEqual(none.cwd, null);
  c.send({ type: 'pty:kill', tabId });
  c.close();
});
