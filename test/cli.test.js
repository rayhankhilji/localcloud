// The CLI binary, the background daemon and the MCP server, as real processes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { hostOf, localServer, newClient, req, sleep, startRelay, waitFor } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/localcloud.js', import.meta.url));

function makeEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(https?|all|no)_proxy$/i.test(k) || k.startsWith('LOCALCLOUD_')) delete env[k];
  }
  return { ...env, NO_PROXY: '127.0.0.1,localhost', NO_COLOR: '1', LOCALCLOUD_HOME: home, ...extra };
}

/** Run the CLI to completion. */
function run(args, { env, cwd, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`localcloud ${args.join(' ')} timed out\n${stdout}\n${stderr}`));
    }, timeout);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, json: () => JSON.parse(stdout.trim().split('\n').at(-1)) });
    });
  });
}

describe('argument parsing and exit codes', () => {
  test('boolean flags never swallow the next argument', () => {
    const { flags, positional } = parseArgs(['init', '--all', '--dry-run', '--no-detect', '--no-claude', '--skill', '--setup', '--mcp', '--no-hook', 'extra']);
    for (const k of ['all', 'dry-run', 'no-detect', 'no-claude', 'skill', 'setup', 'mcp', 'no-hook']) assert.equal(flags[k], true, k);
    assert.deepEqual(positional, ['init', 'extra']);
    assert.deepEqual(parseArgs(['3000', '--name', 'x', '-q', '--trust-proxy=false']).flags, { name: 'x', quiet: true, 'trust-proxy': false });
    assert.deepEqual(parseArgs(['run', '--', 'npm', 'run', 'dev']).rest, ['npm', 'run', 'dev']);
  });

  test('usage errors exit 2', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
    const env = makeEnv(home);
    try {
      for (const args of [['--name'], ['url'], ['config', 'unset', 'bogus'], ['3000']]) {
        const r = await run(args, { env, cwd: home });
        assert.equal(r.code, 2, `${args.join(' ')} → ${r.code}: ${r.stderr}`);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('daemon via the CLI', () => {
  let relay, app, home, env, cwd;

  before(async () => {
    relay = await startRelay();
    app = await localServer((rq, res) => res.end(`app ${rq.url}`));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cwd-'));
    env = makeEnv(home, { LOCALCLOUD_RELAY: relay.url });
  });

  after(async () => {
    const st = await run(['ls', '--json'], { env, cwd }).catch(() => null);
    const pid = st?.code === 0 ? st.json().pid : null;
    await run(['stop'], { env, cwd }).catch(() => {});
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await app.stop();
    await relay.relay.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('--version and help', async () => {
    const v = await run(['--version'], { env, cwd });
    assert.equal(v.code, 0);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
    const h = await run(['--help'], { env, cwd });
    assert.match(h.stdout, /Usage/);
  });

  test('ls when nothing runs', async () => {
    const r = await run(['ls', '--json'], { env, cwd });
    assert.deepEqual(r.json(), { running: false, tunnels: [] });
  });

  test('start / url / ls / stop <port> / stop', async () => {
    let r = await run(['start', String(app.port), '--json'], { env, cwd });
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.relay, relay.url);
    assert.equal(out.tunnels.length, 1);
    const url = out.tunnels[0].url;
    assert.match(url, /^http:\/\/[a-z0-9-]+\.lc\.test$/);
    assert.equal((await req(relay.port, { host: hostOf(url), path: '/x' })).text(), 'app /x');
    assert.ok(fs.existsSync(path.join(home, 'daemon.sock')));
    assert.ok(fs.existsSync(path.join(home, 'daemon.log')));

    // Asking again returns the same URL from the same daemon.
    r = await run(['url', String(app.port)], { env, cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), url);

    r = await run(['start', `localhost:${app.port}`, '--name', 'cli-named', '--json'], { env, cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().tunnels[0].url, 'http://cli-named.lc.test');

    const other = await localServer((_rq, res) => res.end('other'));
    try {
      r = await run(['start', String(other.port), '--json'], { env, cwd });
      assert.equal(r.code, 0, r.stderr);
      const otherUrl = r.json().tunnels[0].url;
      assert.equal((await req(relay.port, { host: hostOf(otherUrl) })).text(), 'other');

      r = await run(['ls', '--json'], { env, cwd });
      let st = r.json();
      assert.equal(st.running, true);
      assert.equal(st.connected, true);
      assert.equal(st.transport, 'ws');
      assert.equal(st.tunnels.length, 2);

      r = await run(['stop', String(other.port)], { env, cwd });
      assert.equal(r.code, 0, r.stderr);
      st = (await run(['ls', '--json'], { env, cwd })).json();
      assert.deepEqual(
        st.tunnels.map((t) => t.port),
        [app.port],
      );
      assert.equal((await req(relay.port, { host: hostOf(otherUrl) })).status, 404);

      r = await run(['stop', '65000'], { env, cwd });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /nothing is shared/);

      const human = await run(['ls'], { env, cwd });
      assert.match(human.stdout, /cli-named\.lc\.test/);
      const logs = await run(['logs'], { env, cwd });
      assert.match(logs.stdout, /daemon .* ready/);
    } finally {
      await other.stop();
    }

    r = await run(['stop'], { env, cwd });
    assert.equal(r.code, 0);
    await waitFor(async () => (await run(['ls', '--json'], { env, cwd })).json().running === false, { message: 'daemon exit' });
    assert.ok(!fs.existsSync(path.join(home, 'daemon.sock')), 'socket removed');
    await waitFor(async () => (await req(relay.port, { host: hostOf(url) })).status === 404, { message: 'tunnel closed on the relay' });
  });

  test('recovers from a stale socket left by a killed daemon', async () => {
    let r = await run(['start', String(app.port), '--json'], { env, cwd });
    assert.equal(r.code, 0, r.stderr);
    const pid = (await run(['ls', '--json'], { env, cwd })).json().pid;
    process.kill(pid, 'SIGKILL');
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { message: 'daemon killed' },
    );
    assert.ok(fs.existsSync(path.join(home, 'daemon.sock')), 'the killed daemon left its socket behind');
    r = await run(['start', String(app.port), '--json'], { env, cwd });
    assert.equal(r.code, 0, r.stderr);
    const st = (await run(['ls', '--json'], { env, cwd })).json();
    assert.notEqual(st.pid, pid);
    assert.equal((await req(relay.port, { host: hostOf(r.json().tunnels[0].url) })).status, 200);
    await run(['stop'], { env, cwd });
  });

  test('watch mode shares a server that starts later', async () => {
    let r = await run(['start', '--json'], { env, cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().watch, true);
    const late = await localServer((_rq, res) => res.end('late'));
    try {
      const t = await waitFor(
        async () => (await run(['ls', '--json'], { env, cwd })).json().tunnels.find((x) => x.port === late.port && x.url),
        { message: 'auto-shared port', timeout: 15_000, interval: 200 },
      );
      assert.equal((await req(relay.port, { host: hostOf(t.url) })).text(), 'late');
    } finally {
      await late.stop();
      await run(['stop'], { env, cwd });
    }
  });
});

describe('relay token via the CLI', () => {
  test('bad token fails fast; fixing it restarts the daemon', async () => {
    const relay = await startRelay({ token: 'cli-token' });
    const app = await localServer((_rq, res) => res.end('ok'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
    const env = makeEnv(home, { LOCALCLOUD_RELAY: relay.url });
    try {
      const started = Date.now();
      let r = await run(['start', String(app.port), '--token', 'wrong', '--json'], { env, cwd: home });
      assert.equal(r.code, 1);
      assert.match(r.json().errors[0], /LOCALCLOUD_TOKEN/);
      assert.ok(Date.now() - started < 15_000, 'does not wait for the share timeout');

      r = await run(['start', String(app.port), '--token', 'cli-token', '--json'], { env, cwd: home });
      assert.equal(r.code, 0, r.stderr);
      assert.equal((await req(relay.port, { host: hostOf(r.json().tunnels[0].url) })).text(), 'ok');

      // Foreground mode with a bad token exits non-zero.
      r = await run([String(app.port), '--token', 'nope'], { env, cwd: home });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /LOCALCLOUD_TOKEN/);
    } finally {
      await run(['stop'], { env, cwd: home });
      await app.stop();
      await relay.relay.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('names across restarts', () => {
  test('a killed process reclaims its --name immediately (per-machine identity)', async () => {
    const relay = await startRelay();
    const app = await localServer((_rq, res) => res.end('named'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
    const env = makeEnv(home, { LOCALCLOUD_RELAY: relay.url });
    try {
      let r = await run(['start', String(app.port), '--name', 'sticky', '--json'], { env, cwd: home });
      assert.equal(r.code, 0, r.stderr);
      const identity = path.join(home, 'identity');
      assert.equal(fs.statSync(identity).mode & 0o777, 0o600);
      const pid = (await run(['ls', '--json'], { env, cwd: home })).json().pid;
      process.kill(pid, 'SIGKILL');
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      // A foreground share of the same name from this machine works right away.
      const child = spawn(process.execPath, [BIN, String(app.port), '--name', 'sticky', '--json'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        const line = await waitFor(() => stdout.split('\n').find((l) => l.startsWith('{')), { message: 'json output' });
        assert.equal(JSON.parse(line).tunnels[0].url, 'http://sticky.lc.test');
        assert.equal((await req(relay.port, { host: 'sticky.lc.test' })).text(), 'named');
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      await app.stop();
      await relay.relay.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('foreground share exits 1 when the name belongs to someone else', async () => {
    const relay = await startRelay();
    const app = await localServer((_rq, res) => res.end());
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
    const env = makeEnv(home, { LOCALCLOUD_RELAY: relay.url });
    const owner = newClient(relay.url);
    try {
      await owner.share(String(app.port), { name: 'owned' });
      const r = await run([String(app.port), '--name', 'owned'], { env, cwd: home, timeout: 15_000 });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /already taken/);
    } finally {
      await owner.close();
      await app.stop();
      await relay.relay.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('foreground share', () => {
  test('prints the URL, serves traffic, exits cleanly on SIGINT', async () => {
    const relay = await startRelay();
    const app = await localServer((_rq, res) => res.end('fg'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
    const env = makeEnv(home, { LOCALCLOUD_RELAY: relay.url });
    const child = spawn(process.execPath, [BIN, String(app.port), '--json'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const line = await waitFor(() => stdout.split('\n').find((l) => l.startsWith('{')), { message: 'json output' });
      const out = JSON.parse(line);
      assert.equal((await req(relay.port, { host: hostOf(out.tunnels[0].url) })).text(), 'fg');
      const exited = new Promise((r) => child.once('exit', (code) => r(code)));
      child.kill('SIGINT');
      assert.equal(await exited, 0);
      await waitFor(() => relay.relay.tunnels.size === 0, { message: 'tunnel closed' });
    } finally {
      child.kill('SIGKILL');
      await app.stop();
      await relay.relay.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('MCP server', () => {
  test('initialize, tools/list, tools/call share_port / list_shared / stop_sharing', async () => {
    const relay = await startRelay();
    const app = await localServer((_rq, res) => res.end('mcp'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-home-'));
    const env = makeEnv(home, { LOCALCLOUD_RELAY: relay.url });
    const child = spawn(process.execPath, [BIN, 'mcp'], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      }
    });
    let nextId = 1;
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.equal(init.result.serverInfo.name, 'localcloud');
      assert.ok(init.result.capabilities.tools);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const list = await rpc('tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      for (const n of ['share_port', 'list_shared', 'stop_sharing']) assert.ok(names.includes(n), `missing ${n}`);
      for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

      const unknown = await rpc('no/such/method', {});
      assert.equal(unknown.error.code, -32601);

      const share = await rpc('tools/call', { name: 'share_port', arguments: { port: app.port } });
      assert.ok(!share.result.isError, share.result.content[0].text);
      const url = share.result.content[0].text.match(/http:\/\/\S+/)[0];
      assert.equal((await req(relay.port, { host: hostOf(url) })).text(), 'mcp');

      const listed = await rpc('tools/call', { name: 'list_shared', arguments: {} });
      assert.match(listed.result.content[0].text, new RegExp(url.replace(/[.]/g, '\\.')));

      const stopped = await rpc('tools/call', { name: 'stop_sharing', arguments: { port: app.port } });
      assert.ok(!stopped.result.isError, stopped.result.content[0].text);
      await waitFor(async () => (await req(relay.port, { host: hostOf(url) })).status === 404, { message: 'unshared' });
    } finally {
      child.stdin.end();
      child.kill();
      await run(['stop'], { env, cwd: home });
      await app.stop();
      await relay.relay.close();
      await sleep(10);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
