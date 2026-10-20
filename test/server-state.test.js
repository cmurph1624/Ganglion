'use strict';
// Integration: state persistence, malformed frames and the request guard, against a real
// server.js process (see test/helpers/server.js for the isolation it runs under).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, sleep } = require('./helpers/server');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { if (srv) await srv.stop(); });

const stateFile = () => path.join(srv.home, '.ganglion', 'state.json');

test('state:load answers state:loaded with the reqId', async () => {
  const c = await srv.connect();
  const m = await c.call('state:load', {}, { reply: 'state:loaded' });
  assert.deepStrictEqual(m.state, { tabs: [], activeTabId: null });
  c.close();
});

test('state:save persists to $HOME/.ganglion/state.json; invalid saves are ignored', async () => {
  const c = await srv.connect();
  const state = { tabs: [{ id: 'tab-a', name: 'A' }], activeTabId: 'tab-a' };
  c.send({ type: 'state:save', state });
  const loaded = await c.call('state:load', {}, { reply: 'state:loaded' });
  assert.deepStrictEqual(loaded.state, state);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile(), 'utf8')), state);

  const before = fs.readFileSync(stateFile(), 'utf8');
  c.send({ type: 'state:save' });
  c.send({ type: 'state:save', state: null });
  c.send({ type: 'state:save', state: [] });
  c.send({ type: 'state:save', state: 'garbage' });
  c.send({ type: 'state:save', state: 42 });
  // Messages on one socket are handled in order, so this reply follows the saves.
  const after = await c.call('state:load', {}, { reply: 'state:loaded' });
  assert.deepStrictEqual(after.state, state);
  assert.strictEqual(fs.readFileSync(stateFile(), 'utf8'), before);
  c.close();
});

test('malformed frames neither crash the server nor spawn ptys', async () => {
  const c = await srv.connect();
  for (const raw of ['not json', 'null', '42', '[]', '"str"', '{}', '{"type":"no:such:type"}']) c.send(raw);
  c.send({ type: 'pty:spawn' });
  c.send({ type: 'pty:spawn', tabId: '' });
  c.send({ type: 'pty:spawn', tabId: 42 });
  c.send({ type: 'pty:spawn', tabId: { x: 1 } });
  c.send({ type: 'pty:kill' });
  c.send({ type: 'pty:kill', tabId: 7 });
  c.send({ type: 'pty:write', data: 'echo hi\r' });
  c.send({ type: 'pty:resize', cols: 'x' });
  c.send({ type: 'pty:cwd' });

  const reply = await c.call('state:load', {}, { reply: 'state:loaded' });
  assert.ok(reply.state);
  // Give any (wrongly) spawned shell time to print a prompt.
  await sleep(700);
  const ptyMsgs = c.messages.filter((m) => /^pty:(data|replay|exit)$/.test(m.type));
  assert.deepStrictEqual(ptyMsgs, []);
  // A fresh client still connects and gets no replay: there are no pty buffers.
  const c2 = await srv.connect();
  await c2.call('state:load', {}, { reply: 'state:loaded' });
  await sleep(200);
  assert.deepStrictEqual(c2.messages.filter((m) => m.type === 'pty:replay'), []);
  // No status signal files were created for a bogus tab id.
  assert.deepStrictEqual(fs.readdirSync(srv.tmp).filter((f) => f.startsWith('ganglion-')), []);
  assert.strictEqual(srv.output().includes('message handler failed'), false, srv.output());
  c.close();
  c2.close();
});

test('request guard: foreign Origin WebSocket is refused, foreign Host gets 403', async () => {
  await assert.rejects(srv.connect({ origin: 'https://evil.com' }), /403|Unexpected server response|HTTP/);
  await assert.rejects(srv.connect({ headers: { Host: 'evil.com' } }), /403|Unexpected server response|HTTP/);

  const evilHost = await srv.request({ headers: { Host: 'evil.com' } });
  assert.strictEqual(evilHost.status, 403);
  const evilOrigin = await srv.request({ headers: { Origin: 'https://evil.com' } });
  assert.strictEqual(evilOrigin.status, 403);

  const ok = await srv.request({ headers: { Origin: srv.url } });
  assert.strictEqual(ok.status, 200);
  assert.match(ok.body, /<html/i);
  const okLocal = await srv.request({ headers: { Host: `localhost:${srv.port}` } });
  assert.strictEqual(okLocal.status, 200);

  const c = await srv.connect({ origin: srv.url });
  const m = await c.call('state:load', {}, { reply: 'state:loaded' });
  assert.ok(m.state);
  c.close();
});
