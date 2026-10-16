// Terminal output helpers. Colours only on a TTY and never with NO_COLOR.

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open, close) => (s) => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  under: wrap(4, 24),
};

export const isInteractive = () => !!process.stdout.isTTY;

export function statusColor(status) {
  if (!status) return c.gray;
  if (status >= 500) return c.red;
  if (status >= 400) return c.yellow;
  if (status >= 300) return c.cyan;
  return c.green;
}

export function logo() {
  return `${c.cyan('☁')}  ${c.bold('localcloud')}`;
}

/** The big, friendly "here's your URL" block. */
export function banner(tunnel, { transport } = {}) {
  const url = tunnel.accessUrl || tunnel.url;
  const local = tunnel.target && !/^\d+$/.test(tunnel.target) ? tunnel.target : `http://localhost:${tunnel.port}`;
  const lines = [
    '',
    `  ${logo()}${transport ? c.dim(`  · via ${transport === 'ws' ? 'websocket' : 'https long-poll'}`) : ''}`,
    '',
    `  ${c.green('➜')}  ${c.bold('Public')}   ${c.bold(c.cyan(url))}`,
    `  ${c.dim('➜')}  ${c.dim('Local')}    ${c.dim(local)}`,
  ];
  if (tunnel.accessUrl) lines.push(`  ${c.dim('➜')}  ${c.dim('Private: the link carries an access key — share it only with people you trust')}`);
  lines.push('');
  return lines.join('\n');
}

export function requestLine(r) {
  const method = (r.method || '').padEnd(6);
  const status = r.upgrade && r.status === 101 ? c.magenta('WS ') : statusColor(r.status)(String(r.status ?? '---'));
  const ms = r.ms !== undefined ? c.dim(`${r.ms}ms`.padStart(7)) : '';
  const err = r.error ? c.red(` ${r.error}`) : '';
  const path = r.url.length > 80 ? r.url.slice(0, 77) + '…' : r.url;
  return `  ${c.dim(new Date().toTimeString().slice(0, 8))}  ${c.bold(method)} ${status} ${ms}  ${path}${err}`;
}
