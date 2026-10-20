'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  idleDelayMs,
  hasUndistilledTurns,
  scheduleOnIngest,
  shouldRunNow,
} = require('../lib/distill-schedule');

test('idle delay defaults to 10 minutes and honours GANGLION_DISTILL_IDLE_MIN', () => {
  assert.strictEqual(idleDelayMs({}), 10 * 60 * 1000);
  assert.strictEqual(idleDelayMs({ GANGLION_DISTILL_IDLE_MIN: '2' }), 2 * 60 * 1000);
  assert.strictEqual(idleDelayMs({ GANGLION_DISTILL_IDLE_MIN: 'x' }), 10 * 60 * 1000);
  assert.strictEqual(idleDelayMs({ GANGLION_DISTILL_IDLE_MIN: '0' }), 10 * 60 * 1000);
});

test('a Stop with new turns restarts the idle timer instead of distilling now', () => {
  assert.strictEqual(scheduleOnIngest({ event: 'Stop', added: 4, turnCount: 10 }), 'idle');
});

test('a Stop with nothing new does nothing', () => {
  assert.strictEqual(scheduleOnIngest({ event: 'Stop', added: 0, turnCount: 10 }), null);
});

test('SessionEnd distills soon when there is anything to cover', () => {
  assert.strictEqual(scheduleOnIngest({ event: 'SessionEnd', added: 2, turnCount: 10 }), 'end');
  // Last Stop already ingested everything, but no note has covered it yet.
  assert.strictEqual(
    scheduleOnIngest({ event: 'SessionEnd', added: 0, turnCount: 10, distilledTurns: 6 }),
    'end'
  );
  assert.strictEqual(scheduleOnIngest({ event: 'SessionEnd', added: 0, turnCount: 10, hasSummary: false }), 'end');
});

test('SessionEnd after the idle note already covered every turn does nothing', () => {
  assert.strictEqual(
    scheduleOnIngest({ event: 'SessionEnd', added: 0, turnCount: 10, distilledTurns: 10 }),
    null
  );
});

test('after a restart, a stale SessionEnd signal for a noted session does nothing', () => {
  // Boot drain re-reads every signal file; this must not re-distill old sessions.
  assert.strictEqual(scheduleOnIngest({ event: 'SessionEnd', added: 0, turnCount: 10, hasSummary: true }), null);
});

test('hasUndistilledTurns', () => {
  assert.strictEqual(hasUndistilledTurns({ turnCount: 0 }), false);
  assert.strictEqual(hasUndistilledTurns({ turnCount: 5, hasSummary: false }), true);
  assert.strictEqual(hasUndistilledTurns({ turnCount: 5, hasSummary: true }), false);
  assert.strictEqual(hasUndistilledTurns({ turnCount: 5, distilledTurns: 5, hasSummary: true }), false);
  assert.strictEqual(hasUndistilledTurns({ turnCount: 7, distilledTurns: 5, hasSummary: true }), true);
});

test('shouldRunNow skips a session this process already covered', () => {
  assert.strictEqual(shouldRunNow({ turnCount: 10 }), true);
  assert.strictEqual(shouldRunNow({ turnCount: 10, distilledTurns: 10 }), false);
  assert.strictEqual(shouldRunNow({ turnCount: 12, distilledTurns: 10 }), true);
  assert.strictEqual(shouldRunNow({ turnCount: 0 }), false);
});

test('a "(no note)" session recorded in distilled_turns is not re-run by a stale SessionEnd', () => {
  // No summary, but the last run covered all 3 turns (the model answered "(no note)").
  assert.strictEqual(
    scheduleOnIngest({ event: 'SessionEnd', added: 0, turnCount: 3, hasSummary: false, distilledTurns: 3 }),
    null
  );
});
