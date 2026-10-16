import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { PortWatcher, listeningPorts, watchSupported } from '../src/watch.js';

const listen = async (host = '127.0.0.1') => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, host, r));
  return s;
};
const once = (emitter, event, filter) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} event`)), 5000);
    const fn = (v) => {
      if (filter && !filter(v)) return;
      clearTimeout(timer);
      emitter.off(event, fn);
      resolve(v);
    };
    emitter.on(event, fn);
  });

test('listeningPorts sees a listening socket', { skip: !watchSupported() }, async () => {
  const s = await listen();
  try {
    const ports = await listeningPorts();
    assert.equal(ports.get(s.address().port), '127.0.0.1');
  } finally {
    s.close();
  }
});

test('PortWatcher detects a newly listening port and its shutdown', { skip: !watchSupported() }, async () => {
  const existing = await listen();
  const w = new PortWatcher({ interval: 50, includeExisting: 'all' });
  const seen = [];
  w.on('port', (p) => seen.push(p));
  try {
    await w.start();
    assert.ok(seen.includes(existing.address().port), 'includeExisting: all reports existing ports');

    const s = await listen('0.0.0.0');
    const port = s.address().port;
    assert.equal(await once(w, 'port', (p) => p === port), port);
    s.close();
    assert.equal(await once(w, 'closed', (p) => p === port), port);

    // Listening again is reported again.
    const again = net.createServer();
    await new Promise((r) => again.listen(port, '127.0.0.1', r));
    assert.equal(await once(w, 'port', (p) => p === port), port);
    again.close();
  } finally {
    w.stop();
    existing.close();
  }
});

test('PortWatcher skips existing ports by default and honours ignore', { skip: !watchSupported() }, async () => {
  const existing = await listen();
  const w = new PortWatcher({ interval: 50, includeExisting: 'none' });
  const seen = [];
  w.on('port', (p) => seen.push(p));
  try {
    await w.start();
    const ignored = await listen();
    w.ignore.add(ignored.address().port);
    // Wait for a full tick to observe both ports.
    const probe = await listen();
    await once(w, 'port', (p) => p === probe.address().port);
    assert.ok(!seen.includes(existing.address().port));
    // The ignored port may have been picked up by a tick before we added it to the ignore list;
    // a fresh watcher with the ignore list must never report it.
    const w2 = new PortWatcher({ interval: 50, includeExisting: 'all', ignore: [ignored.address().port] });
    const seen2 = [];
    w2.on('port', (p) => seen2.push(p));
    await w2.start();
    w2.stop();
    assert.ok(!seen2.includes(ignored.address().port));
    ignored.close();
    probe.close();
  } finally {
    w.stop();
    existing.close();
  }
});

test('stop() stops ticking', { skip: !watchSupported() }, async () => {
  const w = new PortWatcher({ interval: 20, includeExisting: 'none' });
  await w.start();
  w.stop();
  const seen = [];
  w.on('port', (p) => seen.push(p));
  const s = await listen();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(seen, []);
  s.close();
});
