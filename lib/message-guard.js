'use strict';
// Input checks for WebSocket messages. A message that fails them is dropped instead of
// reaching a handler that would throw (and an uncaught throw kills every pty).

// Raw frame → message object, or null for bad JSON and non-objects (`null`, `42`, `"x"`).
function parseMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function isTabId(tabId) {
  return typeof tabId === 'string' && tabId.length > 0;
}

// state:save must carry an object, or state.json gets overwritten with garbage.
function isSavableState(state) {
  return !!state && typeof state === 'object' && !Array.isArray(state);
}

module.exports = { parseMessage, isTabId, isSavableState };
