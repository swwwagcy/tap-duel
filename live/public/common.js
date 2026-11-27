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

  // A QR code for an address, as SVG (vendor/qrcode-generator.js must be on the page). Dark on a
  // light square with a quiet margin, so a phone camera reads it off any screen.
  Live.qrSvg = function (text) {
    if (typeof qrcode !== 'function') return '';
    var code = qrcode(0, 'M'); code.addData(text); code.make();
    var count = code.getModuleCount(), margin = 3, size = count + margin * 2, path = '';
    for (var row = 0; row < count; row++) for (var col = 0; col < count; col++) if (code.isDark(row, col)) path += 'M' + (col + margin) + ' ' + (row + margin) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="QR code" shape-rendering="crispEdges"><rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
  };
  // The address of another page of this site, as someone else would open it.
  Live.pageUrl = function (page) { return new URL(page, location.href).href.replace(/[?#].*$/, '') + (Live.demo && !/\.github\.io$/.test(location.hostname) ? '?demo' : ''); };

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
    // A page that owns an engine uses it itself; a window opened from such a page uses its opener's.
    var own = window.__demoEngine || null;
    try { if (!own && window.opener && window.opener.__demoEngine) own = window.opener.__demoEngine; } catch (error) { /* another origin */ }
    try { for (var up = window; up.parent !== up && !parentEngine;) { up = up.parent; if (up.__demoEngine) parentEngine = up.__demoEngine; } } catch (error) { /* another origin */ }
    if (parentEngine) { transport = overEngine(parentEngine); Live.embedded = true; document.documentElement.classList.add('embedded'); }
    else if (own) transport = overEngine(own);
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
    var api = { online: true, send: function (message) { transport.post(message); }, close: function () { transport.close(); }, reopen: function () {} };
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
      close: function () { closedByPage = true; if (socket) socket.close(); },
      reopen: function () { closedByPage = false; open(); }
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
  // The viewer pages (everything but host and reader) have their own slot too, for VIEWER_KEY.
  var staffPage = /(host|reader|stage|table|admin)\.html$/.test(location.pathname);
  // Inside the single on-site page the table is chosen once, outside; the pages' own table tabs are hidden.
  if (/[?&]embed\b/.test(location.search)) document.documentElement.classList.add('embedded');
  function keySlot() { return /reader\.html$/.test(location.pathname) ? 'tdl-reader-key' : /stage\.html$/.test(location.pathname) ? 'tdl-stage-key' : staffPage ? 'tdl-staff-key' : 'tdl-viewer-key'; }
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
    box.innerHTML = '<form><h2>' + (staffPage ? '輸入工作人員密碼' : '輸入觀看密碼') + '</h2>' + (wrong === 'locked' ? '<p class="bad">密碼錯太多次，這個網路位址暫時被鎖住。請等 10 分鐘再試。</p>' : wrong ? '<p class="bad">密碼不對，請再輸入一次。</p>' : (staffPage ? '<p>主持台、讀牌器與主持人畫面需要密碼（主持人畫面也接受讀牌器的密碼）。</p>' : '<p>這個頁面需要密碼，請向主持人索取。</p>')) +
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

  // A viewer page that was refused: stop reconnecting (each try counts as a wrong key), ask, connect again.
  Live.viewerDenied = function (link, message, after) {
    link.close();
    Live.askStaffKey(function () { if (after) after(); else link.reopen(); }, message.locked ? 'locked' : Live.store.get(keySlot(), '') || Live.store.get('tdl-staff-key', '') ? true : false);
  };

  /* Results so far, as viewers of this kind of table expect to read them: a bead road (six to a
     column, oldest at the top left), counts per side, and how the room's points split this round. */
  Live.sideOf = function (code) { return code === 'R' || code === 'red' ? 'red' : code === 'U' || code === 'blue' ? 'blue' : 'tie'; };
  var SIDE_WORD = { red: '紅', blue: '藍', tie: '平' };
  Live.roadStats = function (road) {
    var stats = { red: 0, blue: 0, tie: 0, total: (road || []).length };
    (road || []).forEach(function (code) { stats[Live.sideOf(code)]++; });
    return stats;
  };
  Live.roadStatsHtml = function (road) {
    var stats = Live.roadStats(road);
    return '<span class="roadstats">近 ' + stats.total + ' 回合 <b class="red">紅 ' + stats.red + '</b><b class="blue">藍 ' + stats.blue + '</b><b class="tie">平 ' + stats.tie + '</b></span>';
  };
  // maxColumns keeps the newest columns; a column is never split, so results stay in their rows.
  Live.beadRoadHtml = function (road, maxColumns) {
    var list = road || [], rows = 6, columns = Math.ceil(list.length / rows);
    var shown = list.slice(Math.max(0, columns - (maxColumns || columns)) * rows);
    var cells = shown.map(function (code) { var side = Live.sideOf(code); return '<span class="' + side + '">' + SIDE_WORD[side] + '</span>'; }).join('');
    var blanks = Math.max(maxColumns || 0, Math.ceil(shown.length / rows) || 1) * rows - shown.length;
    for (var index = 0; index < blanks; index++) cells += '<span class="blank"></span>';
    return '<div class="bead">' + cells + '</div>';
  };
  // The three main spots' share of the room's points this round (side bets are left out).
  Live.shareOf = function (game, totals) {
    var main = game.spots.slice(0, 3), sum = main.reduce(function (total, spot) { return total + (totals[spot.id] || 0); }, 0);
    return main.map(function (spot) { return { id: spot.id, side: spot.side, label: spot.label, percent: sum ? Math.round((totals[spot.id] || 0) * 100 / sum) : 0, amount: totals[spot.id] || 0 }; });
  };
  Live.shareBarHtml = function (game, totals) {
    var parts = Live.shareOf(game, totals), any = parts.some(function (part) { return part.amount > 0; });
    if (!any) return '<div class="sharebar empty" aria-label="全場還沒有人選擇"></div>';
    return '<div class="sharebar" aria-label="全場點數比例">' + parts.map(function (part) {
      return part.amount ? '<span class="' + part.side + '" style="flex:' + part.amount + '">' + (part.percent >= 12 ? part.percent + '%' : '') + '</span>' : '';
    }).join('') + '</div>';
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
