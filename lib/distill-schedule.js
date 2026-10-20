'use strict';
// When to write a session note. The distiller is an LLM call, so it should run once per
// stretch of work, not after every reply:
//
//   - each Stop that ingests new turns (re)starts an idle timer for the session;
//   - SessionEnd runs it soon (the session is over);
//   - a run is skipped when the session has no turns since the last note.
//
// "Turns since the last note" is tracked in memory, so after a restart it is unknown; then
// a session that already has a note counts as up to date until it gets new turns.

const END_DELAY_MS = 3000;
const DEFAULT_IDLE_MIN = 10;

function idleDelayMs(env = process.env) {
  const min = Number(env.GANGLION_DISTILL_IDLE_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_IDLE_MIN) * 60 * 1000;
}

// Does the session have turns the current note doesn't cover?
// distilledTurns: turn count at the last run this process made, or undefined if none.
function hasUndistilledTurns({ turnCount, distilledTurns, hasSummary }) {
  if (!turnCount) return false;
  if (distilledTurns !== undefined) return turnCount > distilledTurns;
  return !hasSummary;
}

// What an ingest signal should do: 'end' (run soon), 'idle' (restart the idle timer) or
// null (leave any pending timer alone).
function scheduleOnIngest({ event, added, turnCount, distilledTurns, hasSummary }) {
  const ended = event === 'SessionEnd';
  if (added > 0) return ended ? 'end' : 'idle';
  if (ended && hasUndistilledTurns({ turnCount, distilledTurns, hasSummary })) return 'end';
  return null;
}

// Last check when the timer fires: skip if this process already covered every turn.
function shouldRunNow({ turnCount, distilledTurns }) {
  if (!turnCount) return false;
  return distilledTurns === undefined || turnCount > distilledTurns;
}

module.exports = {
  END_DELAY_MS,
  DEFAULT_IDLE_MIN,
  idleDelayMs,
  hasUndistilledTurns,
  scheduleOnIngest,
  shouldRunNow,
};
