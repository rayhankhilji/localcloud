// Zero-dependency demo: an HTML page, a Server-Sent Events stream and a websocket echo,
// to show that streaming responses and upgrades work through a localcloud tunnel.
//   node server.js            → http://localhost:8080
//   npx -y localcloud-cli run -- node server.js

import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>localcloud × SSE + WebSocket</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:4rem auto;padding:0 1rem}pre{background:#f4f4f5;padding:.75rem;min-height:6rem;white-space:pre-wrap}</style>
</head><body>
<h1>SSE + WebSocket through a tunnel</h1>
<h2>Server-Sent Events</h2><pre id="sse"></pre>
<h2>WebSocket echo</h2>
<form id="f"><input id="msg" value="hello" autocomplete="off"> <button>send</button></form><pre id="ws"></pre>
<script>
const $ = (id) => document.getElementById(id);
const log = (el, s) => { el.textContent = (s + '\\n' + el.textContent).slice(0, 2000); };
const es = new EventSource('/events');
es.onmessage = (e) => log($('sse'), e.data);
es.onerror = () => log($('sse'), '(reconnecting…)');
const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
ws.onopen = () => log($('ws'), 'connected');
ws.onmessage = (e) => log($('ws'), '← ' + e.data);
ws.onclose = () => log($('ws'), 'closed');
$('f').onsubmit = (e) => { e.preventDefault(); ws.send($('msg').value); log($('ws'), '→ ' + $('msg').value); };
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let n = 0;
    const send = () => res.write(`data: tick ${++n} at ${new Date().toISOString()}\n\n`);
    send();
    const timer = setInterval(send, 1000);
    req.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url === '/health') return res.end('ok\n');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});

// Minimal RFC 6455 server: handshake + text frame echo (enough for a demo, not a library).
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = readFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.length);
      if (frame.opcode === 0x8) return socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      if (frame.opcode === 0x9) socket.write(encodeFrame(frame.payload, 0xa));
      if (frame.opcode === 0x1) socket.write(encodeFrame(Buffer.from(`echo: ${frame.payload.toString()}`)));
    }
  });
  socket.on('error', () => {});
});

function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = buf[1] & 0x80;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const maskOff = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskOff + (i % 4)];
  return { opcode, payload, length: off + len };
}

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126 && len < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else if (len >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
