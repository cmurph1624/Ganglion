'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { serverPort } = require('../lib/server-probe');

test('serverPort defaults to 3000', () => {
  assert.strictEqual(serverPort({}), 3000);
});

test('serverPort honours PORT', () => {
  assert.strictEqual(serverPort({ PORT: '4200' }), 4200);
});

test('serverPort returns a number even though env values are strings', () => {
  assert.strictEqual(typeof serverPort({ PORT: '4200' }), 'number');
});

test('serverPort falls back to the default for values that are not usable ports', () => {
  for (const PORT of ['', 'abc', '0', '-1', '70000', '80.5']) {
    assert.strictEqual(serverPort({ PORT }), 3000, `PORT=${JSON.stringify(PORT)}`);
  }
});
