// Small, friendly HTML pages the relay serves when it cannot hand a request
// to a local server (tunnel offline, nothing listening yet, unknown URL…).

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CLOUD = `<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><path fill="url(#g)" d="M20 50h26a12 12 0 0 0 1.6-23.9A16 16 0 0 0 17 23.5 13.5 13.5 0 0 0 20 50z"/></svg>`;

/**
 * @param {{title: string, heading: string, body: string, poll?: boolean, footer?: string}} p
 */
export function page({ title, heading, body, poll = false, footer = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f8fb;--card:#fff;--fg:#141824;--muted:#5b6475;--line:#e4e7ee;--code:#f1f3f8;--accent:#6d5dfc}
@media (prefers-color-scheme:dark){:root{--bg:#0d1017;--card:#151a24;--fg:#e9ecf3;--muted:#98a1b3;--line:#262d3b;--code:#1d2330;--accent:#a99cff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{width:100%;max-width:560px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px 28px;box-shadow:0 10px 40px -20px rgba(20,24,36,.25)}
h1{font-size:22px;line-height:1.3;margin:14px 0 8px}
p{margin:8px 0;color:var(--muted)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;background:var(--code);border-radius:8px}
code{padding:2px 6px}
pre{padding:12px 14px;overflow-x:auto;color:var(--fg);white-space:pre-wrap;word-break:break-all}
a{color:var(--accent)}
.foot{margin-top:22px;font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
</style>
</head>
<body>
<main>
${CLOUD}
<h1>${heading}</h1>
${body}
${poll ? '<div class="foot"><span class="dot"></span><span>Waiting… this page refreshes by itself.</span></div>' : ''}
${footer ? `<div class="foot">${footer}</div>` : ''}
</main>
${
  poll
    ? `<script>
(function(){var t=1500;function probe(){fetch(location.href,{cache:"no-store",credentials:"same-origin",headers:{"x-localcloud-probe":"1"}}).then(function(r){if(r.status!==502&&r.status!==503&&r.status!==504){location.reload()}else{t=Math.min(t*1.3,5000);setTimeout(probe,t)}}).catch(function(){setTimeout(probe,t)})}setTimeout(probe,t)})();
</script>`
    : ''
}
</body>
</html>`;
}

export function landingPage({ relayUrl, version, routing }) {
  return page({
    title: 'localcloud relay',
    heading: 'localcloud ☁️ relay',
    body: `<p>This relay turns <code>localhost</code> on cloud coding agents — Claude Code, Codex, Cursor, Devin and friends — into shareable HTTPS URLs.</p>
<p>From any machine or agent sandbox:</p>
<pre>npx -y localcloud-cli 3000 --relay ${esc(relayUrl)}</pre>
<p>Or let it pick up every dev server automatically:</p>
<pre>npx -y localcloud-cli start --relay ${esc(relayUrl)}</pre>`,
    footer: `v${esc(version)} · ${esc(routing)} routing · <a href="https://github.com/rayhankhilji/localcloud">github</a>`,
  });
}

export function offlinePage(id) {
  return page({
    title: 'Reconnecting… · localcloud',
    heading: 'This tunnel is reconnecting',
    body: `<p><code>${esc(id)}</code> exists, but the machine sharing it isn't connected right now. Cloud sandboxes sometimes nap — it usually comes back within a few seconds.</p>`,
    poll: true,
  });
}

export function upstreamDownPage(id, port, message) {
  return page({
    title: 'Waiting for your server · localcloud',
    heading: `Nothing is answering on port ${esc(port)} yet`,
    body: `<p>The tunnel <code>${esc(id)}</code> is connected, but the local server isn't responding${message ? ` (<code>${esc(message)}</code>)` : ''}.</p>
<p>Start your dev server (or wait for it to finish booting) and this page will load it automatically.</p>`,
    poll: true,
  });
}

export function notFoundPage(id) {
  return page({
    title: 'Not found · localcloud',
    heading: 'No tunnel at this address',
    body: `<p>There's no active tunnel called <code>${esc(id)}</code>. It may have been stopped, or the link has a typo.</p>`,
  });
}

export function privatePage() {
  return page({
    title: 'Private · localcloud',
    heading: 'This preview is private',
    body: `<p>The person sharing it turned on protection. Open the full share link (it includes an access key) to get in.</p>`,
  });
}
