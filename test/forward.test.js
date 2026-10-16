import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { localRequestHeaders, parseTarget, publicResponseHeaders } from '../src/client/forward.js';

describe('parseTarget', () => {
  const ok = [
    ['3000', { protocol: 'http:', host: null, port: 3000, key: '3000' }],
    [3000, { protocol: 'http:', host: null, port: 3000, key: '3000' }],
    [' :5173 ', { protocol: 'http:', host: null, port: 5173, key: '5173' }],
    ['localhost:8080', { protocol: 'http:', host: null, port: 8080, key: '8080' }],
    ['127.0.0.1:8080', { protocol: 'http:', host: null, port: 8080, key: '8080' }],
    ['http://localhost:4000', { protocol: 'http:', host: null, port: 4000, key: '4000' }],
    ['http://0.0.0.0:4000/', { protocol: 'http:', host: null, port: 4000, key: '4000' }],
    ['http://[::1]:4000', { protocol: 'http:', host: null, port: 4000, key: '4000' }],
    ['https://localhost:8443', { protocol: 'https:', host: null, port: 8443, key: 'https://localhost:8443' }],
    ['https://localhost', { protocol: 'https:', host: null, port: 443, key: 'https://localhost:443' }],
    ['http://localhost', { protocol: 'http:', host: null, port: 80, key: '80' }],
    ['myhost:3000', { protocol: 'http:', host: 'myhost', port: 3000, key: 'myhost:3000' }],
    ['http://10.0.0.5:9000', { protocol: 'http:', host: '10.0.0.5', port: 9000, key: '10.0.0.5:9000' }],
    ['https://api.internal:8443', { protocol: 'https:', host: 'api.internal', port: 8443, key: 'https://api.internal:8443' }],
  ];
  for (const [spec, expected] of ok) {
    test(`${JSON.stringify(spec)}`, () => assert.deepEqual(parseTarget(spec), expected));
  }
  for (const bad of ['0', '70000', '', 'http://', 'not a url at all', '-1', '3000.5']) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => parseTarget(bad)));
  }
  test('same port spelled differently shares a key', () => {
    assert.equal(parseTarget('3000').key, parseTarget('http://localhost:3000').key);
  });
});

const REQ = {
  origin: 'https://sunny-otter-abcd.lc.test',
  remote: '203.0.113.9',
  proto: 'https',
  headers: [
    ['Host', 'sunny-otter-abcd.lc.test'],
    ['Origin', 'https://sunny-otter-abcd.lc.test'],
    ['Referer', 'https://sunny-otter-abcd.lc.test/page?x=1'],
    ['Accept', 'text/html'],
  ],
};
const get = (pairs, name) => pairs.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);

describe('localRequestHeaders', () => {
  test('rewrite mode makes the request look local', () => {
    const h = localRequestHeaders(REQ, { target: parseTarget('5173') });
    assert.deepEqual(get(h, 'host'), ['localhost:5173']);
    assert.deepEqual(get(h, 'origin'), ['http://localhost:5173']);
    assert.deepEqual(get(h, 'referer'), ['http://localhost:5173/page?x=1']);
    assert.deepEqual(get(h, 'x-forwarded-for'), ['203.0.113.9']);
    assert.deepEqual(get(h, 'x-forwarded-proto'), ['https']);
    assert.deepEqual(get(h, 'x-forwarded-host'), []);
    assert.deepEqual(get(h, 'x-localcloud-url'), [REQ.origin]);
    assert.deepEqual(get(h, 'accept'), ['text/html']);
  });

  test('foreign origins are left alone', () => {
    const r = { ...REQ, headers: [['Origin', 'https://evil.example'], ['Referer', 'https://other.example/']] };
    const h = localRequestHeaders(r, { target: parseTarget('5173') });
    assert.deepEqual(get(h, 'origin'), ['https://evil.example']);
    assert.deepEqual(get(h, 'referer'), ['https://other.example/']);
  });

  test('preserve mode keeps the public host', () => {
    const h = localRequestHeaders(REQ, { target: parseTarget('5173'), hostHeader: 'preserve' });
    assert.deepEqual(get(h, 'host'), ['sunny-otter-abcd.lc.test']);
    assert.deepEqual(get(h, 'origin'), [REQ.origin]);
    assert.deepEqual(get(h, 'x-forwarded-host'), ['sunny-otter-abcd.lc.test']);
  });

  test('custom host', () => {
    const h = localRequestHeaders(REQ, { target: parseTarget('5173'), hostHeader: 'app.local' });
    assert.deepEqual(get(h, 'host'), ['app.local']);
  });

  test('https and default ports', () => {
    assert.deepEqual(get(localRequestHeaders(REQ, { target: parseTarget('https://localhost') }), 'origin'), ['https://localhost']);
    assert.deepEqual(get(localRequestHeaders(REQ, { target: parseTarget('http://localhost') }), 'host'), ['localhost']);
  });
});

describe('publicResponseHeaders', () => {
  const t = { target: parseTarget('3000') };
  test('rewrites local redirects, CORS and cookie domains', () => {
    const raw = [
      'Location', 'http://localhost:3000/login?next=%2F',
      'Access-Control-Allow-Origin', 'http://127.0.0.1:3000',
      'Set-Cookie', 'sid=1; Domain=localhost; Path=/; HttpOnly',
      'Set-Cookie', 'b=2; domain=127.0.0.1',
      'Set-Cookie', 'c=3; Domain=example.com',
      'Transfer-Encoding', 'chunked',
      'Content-Type', 'text/html',
    ];
    const h = publicResponseHeaders(raw, REQ, t);
    assert.deepEqual(get(h, 'location'), [`${REQ.origin}/login?next=%2F`]);
    assert.deepEqual(get(h, 'access-control-allow-origin'), [REQ.origin]);
    assert.deepEqual(get(h, 'set-cookie'), ['sid=1; Path=/; HttpOnly', 'b=2', 'c=3; Domain=example.com']);
    assert.deepEqual(get(h, 'transfer-encoding'), []);
    assert.deepEqual(get(h, 'content-type'), ['text/html']);
  });

  test('leaves other ports, hosts and relative locations alone', () => {
    for (const loc of ['http://localhost:4000/x', '/relative', 'https://example.com/', 'http://localhost:30000/']) {
      assert.deepEqual(get(publicResponseHeaders(['Location', loc], REQ, t), 'location'), [loc]);
    }
    assert.deepEqual(get(publicResponseHeaders(['Location', 'http://localhost:3000'], REQ, t), 'location'), [REQ.origin]);
  });

  test('rewrites redirects to a non-loopback target host', () => {
    const h = publicResponseHeaders(['Location', 'http://myhost:3000/a'], REQ, { target: parseTarget('myhost:3000') });
    assert.deepEqual(get(h, 'location'), [`${REQ.origin}/a`]);
  });
});
