// Shared by the three pages: the connection to the server, the clock offset and small helpers.
(function () {
  'use strict';
  var Live = {};

  // Demo mode runs the server inside the browser: on GitHub Pages, from a file, or with ?demo.
  Live.demo = /\.github\.io$/.test(location.hostname) || /[?&]demo\b/.test(location.search) || location.protocol === 'file:';

  Live.PHASE = { idle: '待開始', open: '選擇中', closed: '已截止', dealing: '出牌中', result: '結果', void: '已取消' };

  Live.store = {
    get: function (key, fallback) { try { var raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch (error) { return fallback; } },
    set: function (key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (error) { return false; } },
    remove: function (key) { try { localStorage.removeItem(key); } catch (error) { /* ignore */ } }
  };

  Live.escape = function (text) { return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); };
  Live.$ = function (id) { return document.getElementById(id); };

  // Server time minus local time, refreshed from every message that carries serverNow.
  Live.offset = 0;
  Live.now = function () { return Date.now() + Live.offset; };
  Live.secondsLeft = function (endsAt) { return endsAt ? Math.max(0, Math.ceil((endsAt - Live.now()) / 1000)) : 0; };

  Live.cardHtml = function (card, extraClass) {
    if (card === 'back') return '<span class="cardface back ' + (extraClass || '') + '"></span>';
    if (!card) return '<span class="cardface empty ' + (extraClass || '') + '"></span>';
    var red = Games.isRed(card);
    return '<span class="cardface ' + (red ? 'red ' : '') + (extraClass || '') + '"><b>' + Live.escape(Games.rankOf(card)) + '</b><i>' + Games.SUIT_SYMBOL[Games.suitOf(card)] + '</i></span>';
  };

  // Demo transport. Inside demo.html the frames use the page's own engine; a standalone tab uses a
  // shared worker (one engine for all tabs of this browser); without shared workers the tab runs
  // its own engine. Messages are copied either way, as they would be over a real connection.
  function demoConnect(options) {
    var transport, parentEngine = null;
    function handle(message) {
      if (message.serverNow) Live.offset = message.serverNow - Date.now();
      if (message.table && message.table.serverNow) Live.offset = message.table.serverNow - Date.now();
      options.onMessage(message);
    }
    function overEngine(engine) {
      var connection = { deliver: function (message) { var copy = JSON.parse(JSON.stringify(message)); setTimeout(function () { handle(copy); }, 0); } };
      engine.connect(connection);
      window.addEventListener('pagehide', function () { engine.disconnect(connection); });
      return { post: function (message) { engine.receive(connection, JSON.parse(JSON.stringify(message))); }, close: function () { engine.disconnect(connection); } };
    }
    // The demo's engine lives in the outermost demo page; a page may sit one frame deeper (the room preview holds the sheet).
    try { for (var up = window; up.parent !== up && !parentEngine;) { up = up.parent; if (up.__demoEngine) parentEngine = up.__demoEngine; } } catch (error) { /* another origin */ }
    if (parentEngine) { transport = overEngine(parentEngine); Live.embedded = true; document.documentElement.classList.add('embedded'); }
    else if (window.SharedWorker) {
      var worker = new SharedWorker('demo-worker.js');
      worker.port.onmessage = function (event) { handle(event.data); };
      worker.port.start();
      transport = { post: function (message) { worker.port.postMessage(message); }, close: function () { worker.port.postMessage({ t: 'bye' }); } };
      window.addEventListener('pagehide', function () { transport.close(); });
    } else {
      if (!Live.localEngine) Live.localEngine = Engine.createEngine(Engine.DEMO_OPTIONS);
      Live.demoAlone = true;
      transport = overEngine(Live.localEngine);
    }
    var api = { online: true, send: function (message) { transport.post(message); }, close: function () { transport.close(); } };
    setTimeout(function () { transport.post(options.hello()); if (options.onStatus) options.onStatus(true); }, 0);
    return api;
  }

  // One WebSocket with automatic reconnect. hello() is re-sent on every (re)connect.
  Live.connect = function (options) {
    if (Live.demo) return demoConnect(options);
    var socket = null, retry = 0, closedByPage = false, queue = [];
    var api = {
      online: false,
      send: function (message) {
        if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
        else queue.push(message);
      },
      close: function () { closedByPage = true; if (socket) socket.close(); }
    };
    function open() {
      var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
      socket = new WebSocket(url);
      socket.onopen = function () {
        retry = 0; api.online = true;
        socket.send(JSON.stringify(options.hello()));
        var pending = queue; queue = [];
        pending.forEach(function (message) { api.send(message); });
        if (options.onStatus) options.onStatus(true);
      };
      socket.onmessage = function (event) {
        var message; try { message = JSON.parse(event.data); } catch (error) { return; }
        if (message.serverNow) Live.offset = message.serverNow - Date.now();
        if (message.table && message.table.serverNow) Live.offset = message.table.serverNow - Date.now();
        options.onMessage(message);
      };
      socket.onclose = function () {
        api.online = false;
        if (options.onStatus) options.onStatus(false);
        if (closedByPage) return;
        retry = Math.min(retry + 1, 6);
        setTimeout(open, 500 * retry);
      };
    }
    open();
    return api;
  };

  // Staff pages (host and reader) need the staff key. It can arrive once in the address
  // (#key=...) and is then kept on this device and removed from the address.
  // The reader may have a key of its own (READER_KEY), so each page remembers its key separately.
  // A reader that has none yet uses the key the host page stored on the same device.
  function keySlot() { return /reader\.html$/.test(location.pathname) ? 'tdl-reader-key' : 'tdl-staff-key'; }
  Live.staffKey = function () {
    if (Live.demo) return 'demo';
    var match = /(?:^|[#&])key=([^&]+)/.exec(location.hash);
    if (match) {
      Live.store.set(keySlot(), decodeURIComponent(match[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    return Live.store.get(keySlot(), '') || Live.store.get('tdl-staff-key', '');
  };
  // wrong: true after a refused key; 'locked' when this address has tried too many wrong keys.
  Live.askStaffKey = function (onKey, wrong) {
    var old = document.querySelector('.keygate'); if (old) old.remove();
    var box = document.createElement('div');
    box.className = 'keygate';
    box.innerHTML = '<form><h2>輸入工作人員密碼</h2>' + (wrong === 'locked' ? '<p class="bad">密碼錯太多次，這個網路位址暫時被鎖住。請等 10 分鐘再試。</p>' : wrong ? '<p class="bad">密碼不對，請再輸入一次。</p>' : '<p>主持台與讀牌器需要密碼，部署時設定在 STAFF_KEY。</p>') +
      '<input id="keyInput" type="password" autocomplete="current-password" required><button class="primary" type="submit">進入</button></form>';
    document.body.appendChild(box);
    box.querySelector('form').addEventListener('submit', function (event) {
      event.preventDefault();
      var key = box.querySelector('input').value.trim();
      if (!key) return;
      Live.store.set(keySlot(), key);
      box.remove();
      onKey(key);
    });
    box.querySelector('input').focus();
  };

  var toastTimer = null;
  Live.toast = function (text, level) {
    var box = Live.$('toast');
    if (!box) return;
    box.textContent = text;
    box.className = 'toast show ' + (level || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = 'toast'; }, 4500);
  };

  // Keeps the screen on for the host and the reader. The browser drops the lock whenever the page
  // is hidden (another app, the screen locked by hand), so it is asked for again whenever the page
  // comes back, and on the next tap if a request was refused (some browsers want a user gesture).
  // Live.awake: 'on', 'off' (asked but not held) or 'unsupported'. onAwakeChange is told each change.
  Live.awake = 'off';
  Live.onAwakeChange = null;
  var wakeLock = null, wanted = false;
  function setAwake(value) { if (Live.awake === value) return; Live.awake = value; if (Live.onAwakeChange) Live.onAwakeChange(value); }
  function requestAwake() {
    if (!wanted || wakeLock || document.visibilityState !== 'visible') return;
    if (!('wakeLock' in navigator)) { setAwake('unsupported'); return; }
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock; setAwake('on');
      lock.addEventListener('release', function () { wakeLock = null; setAwake('off'); });
    }).catch(function () { setAwake('off'); });
  }
  Live.keepAwake = function () {
    if (wanted) { requestAwake(); return; }
    wanted = true;
    document.addEventListener('visibilitychange', requestAwake);
    document.addEventListener('pointerdown', requestAwake, true);
    requestAwake();
  };

  // A small tag so nobody mistakes the demo for the real thing.
  if (Live.demo) document.addEventListener('DOMContentLoaded', function () {
    if (window.parent !== window || document.body.dataset.noDemoTag) return;
    var tag = document.createElement('a');
    tag.className = 'demotag'; tag.href = 'demo.html';
    tag.textContent = Live.demoAlone ? '示範模式（這個瀏覽器的分頁不共用資料）' : '示範模式';
    document.body.appendChild(tag);
  });

  window.Live = Live;
})();
