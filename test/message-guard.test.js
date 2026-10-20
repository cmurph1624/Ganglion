'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseMessage, isTabId, isSavableState } = require('../lib/message-guard');

test('parseMessage drops bad JSON and non-objects', () => {
  for (const raw of ['', 'not json', 'null', '42', '"x"', 'true', '[1,2]']) {
    assert.strictEqual(parseMessage(raw), null, raw);
  }
  assert.deepStrictEqual(parseMessage('{"type":"state:load"}'), { type: 'state:load' });
});

test('isTabId requires a non-empty string', () => {
  for (const v of [undefined, null, '', 42, {}, ['a']]) assert.ok(!isTabId(v), String(v));
  assert.ok(isTabId('abc-123'));
  assert.ok(isTabId('abc-123-right'));
});

test('isSavableState refuses a missing or non-object state', () => {
  for (const v of [undefined, null, 'x', 42, []]) assert.ok(!isSavableState(v), String(v));
  assert.ok(isSavableState({ tabs: [], activeTabId: null }));
});
