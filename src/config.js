// Where localcloud finds its settings, highest priority first:
//   1. command line flags          --relay, --token, --transport
//   2. environment                 LOCALCLOUD_RELAY, LOCALCLOUD_TOKEN, LOCALCLOUD_TRANSPORT
//   3. project file                localcloud.json (searched upwards from the cwd)
//   4. user file                   ~/.localcloud/config.json
//   5. the built-in default relay

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The hosted relay used when nothing else is configured. Set this once you
 * deploy your relay (see docs/self-hosting.md) and every `npx localcloud-cli`
 * works with zero configuration.
 */
export const DEFAULT_RELAY = null;

export function homeDir() {
  return process.env.LOCALCLOUD_HOME || path.join(os.homedir(), '.localcloud');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function findProjectConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    for (const name of ['localcloud.json', '.localcloud.json']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return { file, data: readJson(file) || {} };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A per-machine secret that proves to the relay that tunnel names are ours, so a
 * restarted CLI or daemon reclaims its --name right away instead of finding it
 * reserved for the process that died. Stored in $LOCALCLOUD_HOME/identity (0600).
 */
export function clientSecret() {
  const file = path.join(homeDir(), 'identity');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {}
  const secret = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, secret + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    // Another process created it first: use theirs.
    if (err.code === 'EEXIST') {
      try {
        const theirs = fs.readFileSync(file, 'utf8').trim();
        if (theirs.length >= 16) return theirs;
      } catch {}
    }
    // Read-only home etc.: fall back to a per-process secret.
  }
  return secret;
}

export function userConfigPath() {
  return path.join(homeDir(), 'config.json');
}

/** @param {{relay?: string, token?: string, transport?: string}} [flags] */
export function resolveConfig(flags = {}) {
  const env = process.env;
  const project = findProjectConfig();
  const user = readJson(userConfigPath()) || {};
  const pick = (key, envKey) => {
    if (flags[key]) return { value: flags[key], source: `--${key}` };
    if (env[envKey]) return { value: env[envKey], source: envKey };
    if (project?.data?.[key]) return { value: project.data[key], source: project.file };
    if (user[key]) return { value: user[key], source: userConfigPath() };
    return { value: undefined, source: null };
  };
  const relay = pick('relay', 'LOCALCLOUD_RELAY');
  if (!relay.value && DEFAULT_RELAY) Object.assign(relay, { value: DEFAULT_RELAY, source: 'default' });
  const token = pick('token', 'LOCALCLOUD_TOKEN');
  const transport = pick('transport', 'LOCALCLOUD_TRANSPORT');
  return {
    relay: relay.value ? normalizeRelay(relay.value) : undefined,
    relaySource: relay.source,
    token: token.value,
    transport: transport.value || 'auto',
    project,
  };
}

export function normalizeRelay(value) {
  let v = String(value).trim();
  if (!/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  const u = new URL(v);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`;
}

export function writeUserConfig(patch) {
  const file = userConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { ...(readJson(file) || {}), ...patch };
  for (const k of Object.keys(data)) if (data[k] === null || data[k] === undefined) delete data[k];
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}
