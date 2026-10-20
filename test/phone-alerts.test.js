'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { alertConfig, createAlerter, alertMessage, publishNtfy } = require('../lib/phone-alerts');

// A fake clock and timer queue, so the tests decide when the alert delay elapses.
function harness({ delayMs = 30000, doneAfterMs = 5 * 60000 } = {}) {
  let t = 0;
  const timers = new Set();
  const sent = [];
  const alerter = createAlerter({
    delayMs,
    doneAfterMs,
    send: (a) => sent.push(a),
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.add(h); return h; },
    clearTimer: (h) => timers.delete(h),
  });
  const advance = (ms) => {
    t += ms;
    for (const h of [...timers]) if (h.at <= t) { timers.delete(h); h.fn(); }
  };
  return { alerter, sent, advance, pending: () => timers.size };
}

test('alertConfig is null without GANGLION_NTFY_URL and reads the knobs', () => {
  assert.strictEqual(alertConfig({}), null);
  assert.strictEqual(alertConfig({ GANGLION_NTFY_URL: '  ' }), null);
  const c = alertConfig({ GANGLION_NTFY_URL: 'https://ntfy.sh/t', GANGLION_ALERT_DELAY_SEC: '0', GANGLION_ALERT_DONE_MIN: '2' });
  assert.strictEqual(c.delayMs, 0);
  assert.strictEqual(c.doneAfterMs, 120000);
  const d = alertConfig({ GANGLION_NTFY_URL: 'https://ntfy.sh/t', GANGLION_ALERT_DELAY_SEC: 'soon' });
  assert.strictEqual(d.delayMs, 30000, 'bad value falls back to the default');
  assert.strictEqual(d.doneAfterMs, 300000);
});

test('working -> waiting alerts once the tab has stayed red for the delay', () => {
  const h = harness();
  h.alerter.onStatus('a', 'working');
  h.alerter.onStatus('a', 'waiting');
  h.advance(29000);
  assert.deepStrictEqual(h.sent, []);
  h.alerter.onStatus('a', 'waiting'); // repeated watcher fire must not restart the timer
  h.advance(1000);
  assert.deepStrictEqual(h.sent, [{ tabId: 'a', kind: 'waiting' }]);
});

test('answering within the delay sends nothing', () => {
  const h = harness();
  h.alerter.onStatus('a', 'working');
  h.alerter.onStatus('a', 'waiting');
  h.advance(10000);
  h.alerter.onStatus('a', 'working');
  h.advance(60000);
  assert.deepStrictEqual(h.sent, []);
});

test('idle -> waiting (the after-reply reminder) does not alert', () => {
  const h = harness();
  h.alerter.onStatus('a', 'idle');
  h.alerter.onStatus('a', 'waiting');
  h.advance(60000);
  assert.deepStrictEqual(h.sent, []);
});

test('a long run that goes idle sends a done alert; a short one does not', () => {
  const h = harness();
  h.alerter.onStatus('a', 'working');
  h.advance(60000);
  h.alerter.onStatus('a', 'idle');
  h.advance(30000);
  assert.deepStrictEqual(h.sent, [], 'one-minute run is under the threshold');

  h.alerter.onStatus('a', 'working');
  h.advance(4 * 60000);
  h.alerter.onStatus('a', 'waiting'); // time spent waiting on you still counts
  h.advance(10000);
  h.alerter.onStatus('a', 'working');
  h.advance(60000);
  h.alerter.onStatus('a', 'idle');
  h.advance(30000);
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'done');
  assert.strictEqual(h.sent[0].ranMs, 4 * 60000 + 10000 + 60000);
});

test('a new prompt within the delay cancels the done alert', () => {
  const h = harness();
  h.alerter.onStatus('a', 'working');
  h.advance(10 * 60000);
  h.alerter.onStatus('a', 'idle');
  h.advance(5000);
  h.alerter.onStatus('a', 'working');
  h.advance(60000);
  assert.deepStrictEqual(h.sent, []);
});

test('doneAfterMs 0 turns done alerts off; forget clears a pending alert', () => {
  const h = harness({ doneAfterMs: 0 });
  h.alerter.onStatus('a', 'working');
  h.advance(60 * 60000);
  h.alerter.onStatus('a', 'idle');
  h.advance(60000);
  assert.deepStrictEqual(h.sent, []);

  h.alerter.onStatus('b', 'working');
  h.alerter.onStatus('b', 'waiting');
  h.alerter.forget('b');
  assert.strictEqual(h.pending(), 0);
  h.advance(60000);
  assert.deepStrictEqual(h.sent, []);
});

test('alertMessage names the tab and rounds the run time', () => {
  assert.match(alertMessage({ kind: 'waiting' }, 'Ganglion').title, /needs you: Ganglion/);
  assert.match(alertMessage({ kind: 'done', ranMs: 7.4 * 60000 }, 'x').message, /after 7 min/);
  assert.match(alertMessage({ kind: 'waiting' }).title, /a tab/);
});

test('publishNtfy posts JSON to the server root with the topic, token and click URL', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const ok = await publishNtfy(
    { url: 'https://ntfy.example.com/sub/my-topic', token: 'tk', clickUrl: 'http://box:3000' },
    { title: 'Claude needs you: café', message: 'm', tags: ['x'], priority: 4 },
    fetchImpl
  );
  assert.strictEqual(ok, true);
  assert.strictEqual(calls[0].url, 'https://ntfy.example.com/sub');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tk');
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.topic, 'my-topic');
  assert.strictEqual(body.title, 'Claude needs you: café');
  assert.strictEqual(body.click, 'http://box:3000');
});

test('publishNtfy reports failure instead of throwing', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.strictEqual(await publishNtfy({ url: 'https://ntfy.sh/' }, {}, async () => ({ ok: true })), false);
  assert.strictEqual(await publishNtfy({ url: 'https://ntfy.sh/t' }, {}, async () => ({ ok: false, status: 429 })), false);
  assert.strictEqual(await publishNtfy({ url: 'https://ntfy.sh/t' }, {}, async () => { throw new Error('offline'); }), false);
});
