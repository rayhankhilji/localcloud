// Egress proxies: CONNECT tunnelling, NO_PROXY, and proxies that refuse
// WebSockets (the client must fall back to HTTPS long-polling).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { connectProxy, hostOf, localServer, newClient, req, startRelay, waitFor } from './helpers.js';

async function setup(proxyOpts) {
  const r = await startRelay();
  const proxy = await connectProxy(proxyOpts);
  const app = await localServer((rq, res) => res.end(`local ${rq.url}`));
  const wss = new WebSocketServer({ server: app });
  wss.on('connection', (ws) => ws.on('message', (d) => ws.send(`echo:${d}`)));
  const clients = [];
  return {
    ...r,
    proxy,
    app,
    client(opts) {
      const c = newClient(r.url, { proxy: proxy.url, noProxy: '', ...opts });
      clients.push(c);
      return c;
    },
    async stop() {
      await Promise.all(clients.map((c) => c.close()));
      wss.close();
      await app.stop();
      await proxy.close();
      await r.relay.close();
    },
  };
}

function wsEcho(port, host, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host } });
    ws.on('open', () => ws.send(text));
    ws.on('message', (d) => {
      resolve(d.toString());
      ws.terminate();
    });
    ws.on('error', reject);
  });
}

describe('CONNECT proxy', () => {
  for (const transport of ['ws', 'http']) {
    test(`${transport} transport tunnels through the proxy`, async () => {
      const f = await setup();
      try {
        const c = f.client({ transport });
        const t = await c.share(String(f.app.port));
        assert.equal(c.transport.kind, transport);
        assert.ok(f.proxy.stats.connects >= 1);
        assert.ok(f.proxy.stats.targets.every((x) => x === `127.0.0.1:${f.port}`));
        assert.equal((await req(f.port, { host: hostOf(t.url), path: '/p' })).text(), 'local /p');
        assert.equal(await wsEcho(f.port, hostOf(t.url), 'hi'), 'echo:hi');
      } finally {
        await f.stop();
      }
    });
  }

  test('NO_PROXY bypasses the proxy', async () => {
    const f = await setup();
    try {
      const c = f.client({ noProxy: 'localhost,127.0.0.1' });
      const t = await c.share(String(f.app.port));
      assert.equal(f.proxy.stats.connects, 0);
      assert.equal((await req(f.port, { host: hostOf(t.url) })).status, 200);
    } finally {
      await f.stop();
    }
  });

  test('a proxy that blocks WebSockets makes auto mode fall back to long-polling', async () => {
    const f = await setup({ blockWebSocket: true });
    try {
      const c = f.client({ transport: 'auto' });
      const states = [];
      c.on('status', (s) => states.push(s));
      const t = await c.share(String(f.app.port));
      assert.equal(c.transport.kind, 'http');
      assert.ok(f.proxy.stats.blockedUpgrades >= 1);
      const fallback = states.find((s) => s.state === 'fallback');
      assert.ok(fallback, 'emits a fallback status');
      assert.match(fallback.error.message, /403/);
      assert.equal((await req(f.port, { host: hostOf(t.url), path: '/fb' })).text(), 'local /fb');
      // Browser WebSockets still work: they ride the long-poll transport.
      assert.equal(await wsEcho(f.port, hostOf(t.url), 'over-poll'), 'echo:over-poll');

      // After a reconnect it goes straight to long-polling.
      const before = f.proxy.stats.blockedUpgrades;
      for (const s of f.relay.sessions) s.close();
      await waitFor(() => !c.connected, { message: 'disconnect' });
      await waitFor(() => c.connected && c.status.tunnels[0].online, { message: 'reconnect' });
      assert.equal(c.transport.kind, 'http');
      assert.equal(f.proxy.stats.blockedUpgrades, before);
      assert.equal(c.status.tunnels[0].url, t.url);
    } finally {
      await f.stop();
    }
  });

  test('ws mode through a blocking proxy reports the error and keeps retrying', async () => {
    const f = await setup({ blockWebSocket: true });
    try {
      const c = f.client({ transport: 'ws' });
      const errors = [];
      c.on('status', (s) => s.state === 'error' && errors.push(s.error));
      c.start();
      await waitFor(() => errors.length >= 1, { message: 'an error status' });
      assert.match(errors[0].message, /HTTP 403/);
      assert.equal(c.connected, false);
      assert.equal(c.closed, false, 'not fatal');
    } finally {
      await f.stop();
    }
  });

  test('a proxy refusing CONNECT surfaces a helpful error', async () => {
    const f = await setup({ refuse: 403 });
    try {
      const c = f.client();
      const errors = [];
      c.on('status', (s) => s.state === 'error' && errors.push(s.error));
      c.start();
      await waitFor(() => errors.length >= 1, { message: 'an error status' });
      assert.equal(errors[0].code, 'EPROXY');
      assert.match(errors[0].message, /blocked by the network policy/);
      assert.match(c.status.error, /HTTP 403/);
    } finally {
      await f.stop();
    }
  });
});
