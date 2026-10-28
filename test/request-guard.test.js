'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  hostnameOf,
  buildAllowedHosts,
  isAllowedHost,
  isAllowedOrigin,
  httpGuard,
  wsVerifier,
} = require('../lib/request-guard');

const allowed = buildAllowedHosts({ hostname: 'devbox', extra: 'ganglion.lan' });

test('hostnameOf strips ports and IPv6 brackets', () => {
  assert.strictEqual(hostnameOf('localhost:3000'), 'localhost');
  assert.strictEqual(hostnameOf('[::1]:3000'), '::1');
  assert.strictEqual(hostnameOf('::1'), '::1');
  assert.strictEqual(hostnameOf('Devbox:3000'), 'devbox');
  assert.strictEqual(hostnameOf(undefined), null);
});

test('Host: this box by any of its names is allowed', () => {
  for (const h of [
    'localhost:3000',
    '127.0.0.1:3000',
    '[::1]:3000',
    '100.64.0.1:3000',
    'devbox:3000',
    'devbox.tail1234.ts.net:3000',
    'ganglion.lan',
  ]) {
    assert.ok(isAllowedHost(h, allowed), h);
  }
});

test('Host: foreign names (DNS rebinding) are refused', () => {
  for (const h of [
    'evil.com:3000',
    'devbox.evil.com:3000',
    'other.tail1234.ts.net:3000',
    'devbox.tail1234.ts.net.evil.com',
    '',
    undefined,
  ]) {
    assert.ok(!isAllowedHost(h, allowed), String(h));
  }
});

test('Origin: absent is allowed, same-box origins are allowed', () => {
  assert.ok(isAllowedOrigin(undefined, allowed));
  assert.ok(isAllowedOrigin('http://devbox.tail1234.ts.net:3000', allowed));
  assert.ok(isAllowedOrigin('http://100.64.0.1:3000', allowed));
  assert.ok(isAllowedOrigin('http://localhost:3000', allowed));
});

test('Origin: other sites, null and non-http schemes are refused', () => {
  for (const o of ['https://evil.com', 'null', 'file://', 'chrome-extension://abc', 'not a url', '']) {
    assert.ok(!isAllowedOrigin(o, allowed), o);
  }
});

test('httpGuard returns 403 for a cross-site request and passes a same-site one', () => {
  const guard = httpGuard(allowed);
  const run = (headers) => {
    let status = null;
    let nexted = false;
    const res = { status(s) { status = s; return this; }, type() { return this; }, send() {} };
    guard({ headers }, res, () => { nexted = true; });
    return { status, nexted };
  };
  assert.deepStrictEqual(run({ host: 'localhost:3000' }), { status: null, nexted: true });
  assert.deepStrictEqual(run({ host: 'localhost:3000', origin: 'https://evil.com' }), { status: 403, nexted: false });
  assert.deepStrictEqual(run({ host: 'evil.com' }), { status: 403, nexted: false });
});

test('wsVerifier refuses a WebSocket opened by another site', () => {
  const verify = wsVerifier(allowed);
  assert.ok(verify({ req: { headers: { host: 'devbox:3000', origin: 'http://devbox:3000' } } }));
  assert.ok(!verify({ req: { headers: { host: 'devbox:3000', origin: 'https://evil.com' } } }));
  assert.ok(!verify({ req: { headers: { host: 'evil.com', origin: 'https://evil.com' } } }));
});
