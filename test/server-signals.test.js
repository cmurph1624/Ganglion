'use strict';
// Integration: shell exit, Claude Code status signals and transcript ingest against a real
// server.js process. Signal files are written into the instance's own TMPDIR, never /tmp
// (see test/helpers/server.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, sleep, until } = require('./helpers/server');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { if (srv) await srv.stop(); });

const rand = () => crypto.randomBytes(4).toString('hex');
const sig = (tabId, kind) => path.join(srv.tmp, `ganglion-${tabId}-${kind}`);

async function spawned(c, tabId) {
  c.send({ type: 'pty:spawn', tabId });
  await c.waitFor((m) => m.type === 'pty:data' && m.tabId === tabId, { what: `pty:data for ${tabId}` });
}

test('shell exit broadcasts pty:exit and removes the tab signal files', async () => {
  const c = await srv.connect();
  const tabId = `tab-${rand()}`;
  await spawned(c, tabId);
  assert.ok(fs.existsSync(sig(tabId, 'status')));
  assert.ok(fs.existsSync(sig(tabId, 'tool')));
  fs.writeFileSync(sig(tabId, 'ingest'), JSON.stringify({ transcript_path: path.join(srv.base, 'missing.jsonl') }));

  c.send({ type: 'pty:write', tabId, data: 'exit\r' });
  await c.waitFor((m) => m.type === 'pty:exit' && m.tabId === tabId, { what: 'pty:exit' });
  for (const kind of ['status', 'tool', 'ingest']) {
    assert.strictEqual(fs.existsSync(sig(tabId, kind)), false, `${kind} file left behind`);
  }
  c.close();
});

test('writing the status file broadcasts tab:status; -right panes get none', async () => {
  const c = await srv.connect();
  const tabId = `tab-${rand()}`;
  await spawned(c, tabId);
  await c.waitFor((m) => m.type === 'tab:status' && m.tabId === tabId && m.status === 'idle', { what: 'initial idle' });

  let since = c.messages.length;
  fs.writeFileSync(sig(tabId, 'status'), 'working');
  await c.waitFor((m) => m.type === 'tab:status' && m.tabId === tabId && m.status === 'working', { since, what: 'working' });

  since = c.messages.length;
  fs.writeFileSync(sig(tabId, 'tool'), 'Bash');
  await c.waitFor((m) => m.type === 'tab:tool' && m.tabId === tabId && m.tool === 'Bash', { since, what: 'tab:tool' });

  const right = `${tabId}-right`;
  await spawned(c, right);
  assert.strictEqual(fs.existsSync(sig(right, 'status')), false, 'no status file for a right pane');
  fs.writeFileSync(sig(right, 'status'), 'working');
  await sleep(700);
  assert.deepStrictEqual(c.messages.filter((m) => m.type === 'tab:status' && m.tabId === right), []);

  c.send({ type: 'pty:kill', tabId: right });
  c.send({ type: 'pty:kill', tabId });
  await until(() => !fs.existsSync(sig(tabId, 'status')), { what: 'status file removed on kill' });
  fs.rmSync(sig(right, 'status'), { force: true });
  c.close();
});

function writeTranscript(slug, sessionId, text) {
  const dir = path.join(srv.home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const base = { sessionId, timestamp: '2026-07-10T10:00:00Z', cwd: '/proj', gitBranch: 'main' };
  fs.writeFileSync(
    file,
    JSON.stringify({ ...base, type: 'user', uuid: `${sessionId}-u1`, parentUuid: null, message: { role: 'user', content: text } }) + '\n' +
      JSON.stringify({ ...base, type: 'assistant', uuid: `${sessionId}-a1`, parentUuid: `${sessionId}-u1`, message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ack' }] } }) + '\n'
  );
  return file;
}

for (const pane of ['left', 'right']) {
  test(`Stop ingest signal is ingested and searchable (${pane} pane)`, async () => {
    const c = await srv.connect();
    const tabId = pane === 'right' ? `tab-${rand()}-right` : `tab-${rand()}`;
    await spawned(c, tabId);

    const sessionId = `sess-${rand()}`;
    const word = `zephyr${rand()}`;
    const transcript = writeTranscript('-proj-test', sessionId, `please remember ${word} for later`);
    fs.writeFileSync(sig(tabId, 'ingest'), JSON.stringify({ session_id: sessionId, transcript_path: transcript, event: 'Stop' }));

    const ing = await c.waitFor((m) => m.type === 'memory:ingested' && m.sessionId === sessionId, { what: 'memory:ingested' });
    assert.strictEqual(ing.added, 2);

    const r = await c.call('memory:search', { params: { query: word } });
    assert.ok(r.results.length >= 1, 'search found nothing');
    assert.ok(JSON.stringify(r.results).includes(word));

    const s = await c.call('memory:getSession', { sessionId });
    assert.strictEqual(s.data.turns.length, 2);
    const p = await c.call('memory:projects');
    assert.ok(p.projects.includes('-proj-test'));

    c.send({ type: 'pty:kill', tabId });
    await until(() => !fs.existsSync(sig(tabId, 'ingest')), { what: 'ingest file removed on kill' });
    c.close();
  });
}
