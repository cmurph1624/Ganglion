'use strict';
// Phone alerts: push a notification through ntfy when a tab needs you or a long Claude run
// finishes, so work on this always-on box can be left running while you're away.
//
// Off unless GANGLION_NTFY_URL is set. Two kinds of alert:
//   - waiting: the tab went red (working -> waiting, e.g. a permission prompt) and stayed red
//     for the alert delay. A red that comes straight from idle is Claude Code's "still
//     waiting for your input" reminder after a reply, so it is skipped: the "done" alert
//     already covers that moment.
//   - done:    a run that was working for at least GANGLION_ALERT_DONE_MIN went idle and
//     stayed idle for the alert delay.
// The delay means nothing is sent when you're at the screen and answer straight away.

const DEFAULT_DELAY_SEC = 30;
const DEFAULT_DONE_MIN = 5;

function numberEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Alert settings from the environment, or null when alerts are off. */
function alertConfig(env = process.env) {
  const url = (env.GANGLION_NTFY_URL || '').trim();
  if (!url) return null;
  return {
    url,
    token: env.GANGLION_NTFY_TOKEN || '',
    clickUrl: env.GANGLION_ALERT_CLICK_URL || '',
    delayMs: numberEnv(env.GANGLION_ALERT_DELAY_SEC, DEFAULT_DELAY_SEC) * 1000,
    // 0 turns "done" alerts off.
    doneAfterMs: numberEnv(env.GANGLION_ALERT_DONE_MIN, DEFAULT_DONE_MIN) * 60 * 1000,
  };
}

/**
 * Tracks each tab's status and decides when to alert. `send` gets
 * {tabId, kind: 'waiting'|'done', ranMs}. Timers are injectable for tests.
 */
function createAlerter({ send, delayMs, doneAfterMs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tabs = new Map(); // tabId -> { status, workingSince, timer }

  function entry(tabId) {
    let e = tabs.get(tabId);
    if (!e) {
      e = { status: null, workingSince: null, timer: null };
      tabs.set(tabId, e);
    }
    return e;
  }

  function schedule(e, alert) {
    e.timer = setTimer(() => {
      e.timer = null;
      try { send(alert); } catch {}
    }, delayMs);
    if (e.timer && typeof e.timer.unref === 'function') e.timer.unref();
  }

  function onStatus(tabId, status) {
    const e = entry(tabId);
    const prev = e.status;
    // The status file watcher fires on every write, often with the same value.
    if (status === prev) return;
    e.status = status;
    // idle -> waiting is Claude Code's after-reply reminder (~60s after Stop): not an alert
    // of its own, and it must not cancel a pending "done" alert.
    if (status === 'waiting' && prev !== 'working') return;
    if (e.timer) {
      clearTimer(e.timer);
      e.timer = null;
    }

    if (status === 'working') {
      // waiting -> working (you approved something) continues the same run.
      if (e.workingSince === null) e.workingSince = now();
    } else if (status === 'waiting') {
      schedule(e, { tabId, kind: 'waiting' });
    } else {
      const ranMs = e.workingSince === null ? 0 : now() - e.workingSince;
      e.workingSince = null;
      if (doneAfterMs > 0 && ranMs >= doneAfterMs) schedule(e, { tabId, kind: 'done', ranMs });
    }
  }

  function forget(tabId) {
    const e = tabs.get(tabId);
    if (e && e.timer) clearTimer(e.timer);
    tabs.delete(tabId);
  }

  return { onStatus, forget };
}

/** The ntfy message for an alert. */
function alertMessage({ kind, ranMs }, tabName) {
  const name = tabName || 'a tab';
  if (kind === 'waiting') {
    return { title: `Claude needs you: ${name}`, message: `Waiting for your input in "${name}".`, tags: ['raising_hand'], priority: 4 };
  }
  const min = Math.max(1, Math.round((ranMs || 0) / 60000));
  return { title: `Claude finished: ${name}`, message: `Done in "${name}" after ${min} min.`, tags: ['white_check_mark'], priority: 3 };
}

/**
 * Publish to ntfy. Uses the JSON API (POST to the server root with the topic in the body)
 * rather than headers, because header values can't carry non-ASCII tab names.
 * Resolves to true on success; never throws.
 */
async function publishNtfy(config, msg, fetchImpl = fetch) {
  let endpoint;
  let topic;
  try {
    const u = new URL(config.url);
    const parts = u.pathname.split('/').filter(Boolean);
    topic = parts.pop();
    if (!topic) throw new Error('no topic in GANGLION_NTFY_URL');
    u.pathname = '/' + parts.join('/');
    u.search = '';
    endpoint = u.toString();
  } catch (err) {
    console.error('phone alert not sent:', err.message);
    return false;
  }
  const body = { topic, ...msg };
  if (config.clickUrl) body.click = config.clickUrl;
  const headers = { 'Content-Type': 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`phone alert failed: ntfy returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('phone alert failed:', err.message);
    return false;
  }
}

module.exports = { alertConfig, createAlerter, alertMessage, publishNtfy };
