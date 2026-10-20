'use strict';
// Integration: scrollback survives a server restart (SIGTERM), and goes when the tab closes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, until } = require('./helpers/server');
const { SEPARATOR } = require('../lib/scrollback');

const rand = () => crypto.randomBytes(4).toString('hex');

test('scrollback is restored after a restart and removed on pty:kill', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-sbhome-'));
  const tabId = `tab-${rand()}`;
  const marker = `before-restart-${rand()}`;
  const file = path.join(home, '.ganglion', 'scrollback', `${tabId}.log`);
  let srv;
  try {
    srv = await startServer({ home });
    let c = await srv.connect();
    // The boot prune keeps only tabs listed in state.json.
    c.send({ type: 'state:save', state: { tabs: [{ id: tabId, name: 't' }], activeTabId: tabId } });
    c.send({ type: 'pty:spawn', tabId });
    c.send({ type: 'pty:write', tabId, data: `echo ${marker}\r` });
    await c.waitForOutput(tabId, new RegExp(`${marker}\\r?\\n`));
    await srv.stop(); // SIGTERM: cleanup() flushes before killing the ptys
    srv = null;

    assert.ok(fs.readFileSync(file, 'utf8').includes(marker), 'flushed on shutdown');

    srv = await startServer({ home });
    c = await srv.connect();
    c.send({ type: 'pty:spawn', tabId });
    const replay = await c.waitFor((m) => m.type === 'pty:replay' && m.tabId === tabId, { what: 'restored replay' });
    assert.ok(replay.data.includes(marker));
    assert.ok(replay.data.includes(SEPARATOR));
    // A fresh shell is running underneath.
    const token = `after-${rand()}`;
    c.send({ type: 'pty:write', tabId, data: `echo ${token}\r` });
    await c.waitForOutput(tabId, new RegExp(`${token}\\r?\\n`));

    c.send({ type: 'pty:kill', tabId });
    await until(() => !fs.existsSync(file), { what: 'scrollback file removed' });
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a tab missing from state.json loses its saved scrollback at boot', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-sbhome-'));
  const dir = path.join(home, '.ganglion', 'scrollback');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.ganglion', 'state.json'), JSON.stringify({ tabs: [{ id: 'keep' }] }));
  fs.writeFileSync(path.join(dir, 'keep.log'), 'x');
  fs.writeFileSync(path.join(dir, 'gone.log'), 'x');
  let srv;
  try {
    srv = await startServer({ home });
    assert.deepStrictEqual(fs.readdirSync(dir), ['keep.log']);
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
