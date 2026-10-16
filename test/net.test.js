import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connectThroughProxy, matchesNoProxy, proxyFor } from '../src/net.js';
import { connectProxy, localServer } from './helpers.js';

describe('matchesNoProxy', () => {
  const cases = [
    // [host, port, NO_PROXY, expected]
    ['example.com', 443, '', false],
    ['example.com', 443, '*', true],
    ['example.com', 443, 'example.com', true],
    ['EXAMPLE.com', 443, 'example.COM', true],
    ['api.example.com', 443, 'example.com', true],
    ['badexample.com', 443, 'example.com', false],
    ['api.example.com', 443, '.example.com', true],
    ['example.com', 443, '.example.com', true],
    ['a.b.example.com', 443, '*.example.com', true],
    ['example.org', 443, 'example.com, example.org', true],
    ['example.org', 443, 'example.com example.org', true],
    ['example.com', 443, 'example.com:443', true],
    ['example.com', 8443, 'example.com:443', false],
    ['10.1.2.3', 443, '10.0.0.0/8', true],
    ['11.1.2.3', 443, '10.0.0.0/8', false],
    ['192.168.1.20', 80, '192.168.1.0/24', true],
    ['192.168.2.20', 80, '192.168.1.0/24', false],
    ['1.2.3.4', 80, '1.2.3.4/32', true],
    ['1.2.3.5', 80, '1.2.3.4/32', false],
    ['8.8.8.8', 80, '0.0.0.0/0', true],
    ['127.0.0.1', 80, '127.0.0.1', true],
    ['::1', 80, '::1', true],
    ['[::1]', 80, '::1', true],
    ['::1', 8080, '[::1]:8080', true],
    ['::1', 9090, '[::1]:8080', false],
    ['::1', 80, '[::1]', true],
    ['localhost', 80, 'localhost,127.0.0.1', true],
    ['relay.example.com', 443, 'localhost,127.0.0.1,.svc.cluster.local', false],
    ['x.svc.cluster.local', 443, '*.svc.cluster.local', true],
    ['1.2.3.4', 80, 'garbage/99', false],
  ];
  for (const [host, port, noProxy, expected] of cases) {
    test(`${host}:${port} vs "${noProxy}" → ${expected}`, () => {
      assert.equal(matchesNoProxy(host, port, noProxy), expected);
    });
  }
});

describe('proxyFor', () => {
  test('explicit proxy, null disables, NO_PROXY honoured', () => {
    const u = new URL('https://relay.example.com');
    assert.equal(proxyFor(u, { proxy: null }), null);
    assert.equal(proxyFor(u, { proxy: 'http://p:3128', noProxy: '' }).host, 'p:3128');
    assert.equal(proxyFor(u, { proxy: 'p:3128', noProxy: '' }).href, 'http://p:3128/');
    assert.equal(proxyFor(u, { proxy: 'http://p:3128', noProxy: 'example.com' }), null);
    assert.equal(proxyFor(new URL('wss://relay.example.com/x'), { proxy: 'http://p:3128', noProxy: 'relay.example.com:443' }), null);
  });

  test('reads HTTPS_PROXY / HTTP_PROXY from the environment', () => {
    const saved = { ...process.env };
    try {
      for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[k];
      process.env.HTTPS_PROXY = 'http://secure-proxy:1';
      process.env.HTTP_PROXY = 'http://plain-proxy:2';
      assert.equal(proxyFor(new URL('https://x.com')).hostname, 'secure-proxy');
      assert.equal(proxyFor(new URL('wss://x.com')).hostname, 'secure-proxy');
      assert.equal(proxyFor(new URL('http://x.com')).hostname, 'plain-proxy');
      process.env.no_proxy = 'x.com';
      assert.equal(proxyFor(new URL('https://x.com')), null);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('connectThroughProxy', () => {
  test('opens a tunnel', async () => {
    const proxy = await connectProxy();
    const server = await localServer((_req, res) => res.end('through'));
    try {
      const sock = await connectThroughProxy(new URL(proxy.url), '127.0.0.1', server.port);
      sock.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      const chunks = [];
      for await (const c of sock) chunks.push(c);
      assert.match(Buffer.concat(chunks).toString(), /through$/);
      assert.equal(proxy.stats.connects, 1);
    } finally {
      await server.stop();
      await proxy.close();
    }
  });

  test('reports refusals as EPROXY with the status', async () => {
    const proxy = await connectProxy({ refuse: 403 });
    try {
      await assert.rejects(connectThroughProxy(new URL(proxy.url), 'example.com', 443), (err) => {
        assert.equal(err.code, 'EPROXY');
        assert.equal(err.status, 403);
        assert.match(err.message, /HTTP 403/);
        return true;
      });
    } finally {
      await proxy.close();
    }
  });
});
