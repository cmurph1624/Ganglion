'use strict';
// Integration: a real server.js with phone alerts pointed at a local stand-in for ntfy.
// Status changes are made by writing the tab's status file, as the hooks would.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startServer, until } = require('./helpers/server');

let srv;
let sink;
const received = [];

test.before(async () => {
  sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ path: req.url, body: JSON.parse(body) });
      res.end('{}');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  srv = await startServer({
    env: {
      GANGLION_NTFY_URL: `http://127.0.0.1:${sink.address().port}/test-topic`,
      GANGLION_ALERT_DELAY_SEC: '0',
    },
  });
});
test.after(async () => {
  if (srv) await srv.stop();
  if (sink) sink.close();
});

test('a tab that goes from working to waiting sends a phone alert with its name', async () => {
  const tabId = 'tab-alerts-1';
  fs.mkdirSync(path.join(srv.home, '.ganglion'), { recursive: true });
  fs.writeFileSync(path.join(srv.home, '.ganglion', 'state.json'), JSON.stringify({ tabs: [{ id: tabId, name: 'my-repo' }] }));
  const c = await srv.connect();
  c.send({ type: 'pty:spawn', tabId });
  await c.waitFor((m) => m.type === 'tab:status' && m.tabId === tabId && m.status === 'idle', { what: 'initial idle' });

  const status = path.join(srv.tmp, `ganglion-${tabId}-status`);
  fs.writeFileSync(status, 'working');
  await c.waitFor((m) => m.type === 'tab:status' && m.tabId === tabId && m.status === 'working', { what: 'working' });
  fs.writeFileSync(status, 'waiting');

  await until(() => received.length > 0, { what: 'alert at the sink' });
  assert.strictEqual(received[0].path, '/');
  assert.strictEqual(received[0].body.topic, 'test-topic');
  assert.match(received[0].body.title, /needs you: my-repo/);
  assert.match(srv.output(), /phone alerts on/);
  c.send({ type: 'pty:kill', tabId });
  c.close();
});
