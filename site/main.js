// localcloud landing page: copy buttons, setup tabs, animated terminal demo.
(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------ live region
  var live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  function announce(msg) {
    live.textContent = '';
    setTimeout(function () { live.textContent = msg; }, 30);
  }

  // ------------------------------------------------------------ copy buttons
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.copy-btn');
    if (!btn) return;
    var holder = btn.closest('[data-copy]');
    var targetId = btn.getAttribute('data-copy-target');
    var text = targetId ? document.getElementById(targetId).textContent : holder && holder.getAttribute('data-copy');
    if (!text) return;
    copyText(text.trim()).then(function () {
      var label = btn.querySelector('.copy-label');
      btn.classList.add('copied');
      if (label) label.textContent = 'Copied';
      announce('Copied to clipboard');
      clearTimeout(btn._t);
      btn._t = setTimeout(function () {
        btn.classList.remove('copied');
        if (label) label.textContent = 'Copy';
      }, 1800);
    }, function () {
      announce('Copy failed — select the text and copy it manually');
    });
  });

  // ------------------------------------------------------------ setup tabs
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tablist [role="tab"]'));
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    try { localStorage.setItem('lc-tab', tab.id); } catch (e) {}
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectTab(tab); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });
  var hashTab = location.hash && document.getElementById('tab-' + location.hash.slice(1).replace(/^setup-/, ''));
  var savedTab = null;
  try { savedTab = document.getElementById(localStorage.getItem('lc-tab') || ''); } catch (e) {}
  if (hashTab && hashTab.getAttribute('role') === 'tab') selectTab(hashTab);
  else if (savedTab && savedTab.getAttribute('role') === 'tab') selectTab(savedTab);

  // ------------------------------------------------------------ terminal demo
  var body = document.getElementById('term-body');
  if (!body) return;
  var sceneBtns = Array.prototype.slice.call(document.querySelectorAll('.term-tab'));

  var I = '<span class="ind">  </span>';
  var req = function (time, status, ms, path) {
    return I + '<span class="dim t">' + time + '  </span><b>GET   </b> ' + status + ' <span class="dim">' + ms + '</span>  ' + path;
  };
  var SCENES = [
    {
      prompt: '~/my-app $',
      lines: [
        { cmd: 'npx localcloud-cli 3000' },
        { html: ' ', d: 380 },
        { html: I + '<span class="cy cl" aria-hidden="true"></span>  <b>localcloud</b><span class="dim">  · via websocket</span>', d: 520 },
        { html: ' ', d: 40 },
        { html: I + '<span class="gr">➜</span>  <b>Public</b>   <b class="cy url-pop">https://sunny-otter-x7k2.example.com</b>', d: 120 },
        { html: I + '<span class="dim">➜  Local    http://localhost:3000</span>', d: 90 },
        { html: ' ', d: 40 },
        { html: I + '<span class="dim">Requests will show up below. Ctrl+C to stop.</span>', d: 160 },
        { html: ' ', d: 40 },
        { html: req('14:02:11', '<span class="gr">200</span>', '   38ms', '/'), d: 1300 },
        { html: req('14:02:11', '<span class="gr">200</span>', '    6ms', '/favicon.ico'), d: 160 },
        { html: req('14:02:12', '<span class="mg">WS </span>', '    4ms', '/_next/webpack-hmr'), d: 700 },
      ],
    },
    {
      prompt: 'sandbox $',
      lines: [
        { cmd: 'npx localcloud-cli start' },
        { html: '<span class="gr">✓</span> localcloud is watching for dev servers — any port that starts listening gets a public URL.', w: 1, d: 520 },
        { html: I + 'Run <b>localcloud ls</b> (or <b>localcloud url &lt;port&gt;</b>) to see the URLs.', w: 1, d: 60 },
        { cmd: 'npm run dev', d: 700 },
        { html: I + '<b class="gr">VITE</b>  <span class="dim">ready in</span> <b>412</b> <span class="dim">ms</span>', d: 900 },
        { html: I + '<span class="gr">➜</span>  <b>Local</b>:   <span class="cy">http://localhost:5173/</span>', d: 80 },
        { cmd: 'npx localcloud-cli ls', d: 900 },
        { html: '<span class="cy cl" aria-hidden="true"></span>  <b>localcloud</b>  <span class="dim">https://example.com</span>  <span class="gr nb">connected via https long-poll</span><span class="dim">  · auto-sharing new dev servers</span>', w: 1, d: 420 },
        { html: 'http://localhost:5173 → <b class="cy url-pop nb">https://cozy-panda-m3qe.example.com</b>', w: 1, d: 80 },
        { html: ' ', d: 60 },
        { html: '<span class="say">✦ agent: your preview is live → <span class="nb">https://cozy-panda-m3qe.example.com</span></span>', w: 1, d: 1100 },
      ],
    },
  ];

  var run = 0; // incremented to cancel an in-flight animation
  var current = 0;
  var started = false;

  function wait(ms, id) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () { id === run ? resolve() : reject('cancelled'); }, ms);
    });
  }
  function lineEl(html, wrap, animate) {
    var el = document.createElement('span');
    el.className = 'ln' + (wrap ? ' w' : '') + (animate ? ' in' : '');
    el.innerHTML = html;
    return el;
  }
  function promptHtml(scene, text) {
    return '<span class="p">' + scene.prompt + '</span> ' + text;
  }
  function markScene(i) {
    sceneBtns.forEach(function (b, j) { b.setAttribute('aria-pressed', String(i === j)); });
  }
  function renderStatic(i) {
    var scene = SCENES[i];
    body.textContent = '';
    scene.lines.forEach(function (l) {
      var el = lineEl(l.cmd ? promptHtml(scene, l.cmd) : l.html, l.w, false);
      var pop = el.querySelector('.url-pop');
      if (pop) pop.classList.remove('url-pop');
      body.appendChild(el);
    });
  }

  function play(i) {
    var id = ++run;
    current = i;
    markScene(i);
    var scene = SCENES[i];
    body.textContent = '';
    var chain = Promise.resolve();
    scene.lines.forEach(function (l) {
      chain = chain.then(function () {
        if (!l.cmd) {
          return wait(l.d || 60, id).then(function () { body.appendChild(lineEl(l.html, l.w, true)); });
        }
        var el = lineEl(promptHtml(scene, ''), false, false);
        var caret = document.createElement('span');
        caret.className = 'caret';
        el.appendChild(caret);
        body.appendChild(el);
        var typed = document.createTextNode('');
        el.insertBefore(typed, caret);
        var k = 0;
        var step = function () {
          if (k >= l.cmd.length) return wait(420, id).then(function () { caret.remove(); });
          return wait(k === 0 ? (l.d || 500) : 34 + Math.random() * 46, id).then(function () {
            typed.data += l.cmd[k++];
            return step();
          });
        };
        return step();
      });
    });
    chain
      .then(function () { return wait(i === SCENES.length - 1 ? 4200 : 3600, id); })
      .then(function () { play((i + 1) % SCENES.length); })
      .catch(function () {});
  }

  sceneBtns.forEach(function (b, i) {
    b.addEventListener('click', function () {
      if (reduceMotion) { current = i; markScene(i); renderStatic(i); return; }
      play(i);
    });
  });

  if (reduceMotion) return renderStatic(0);

  // Start when the terminal is visible; pause while the tab is hidden.
  function start() {
    if (started) return;
    started = true;
    play(0);
  }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { start(); io.disconnect(); }
    });
    io.observe(body);
  } else start();
  document.addEventListener('visibilitychange', function () {
    if (!started) return;
    if (document.hidden) run++;
    else play(current);
  });
})();
