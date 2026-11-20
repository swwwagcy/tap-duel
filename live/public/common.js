// Shared by the three pages: the connection to the server, the clock offset and small helpers.
(function () {
  'use strict';
  var Live = {};

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
    if (!card) return '<span class="cardface empty ' + (extraClass || '') + '"></span>';
    var red = Games.isRed(card);
    return '<span class="cardface ' + (red ? 'red ' : '') + (extraClass || '') + '"><b>' + Live.escape(Games.rankOf(card)) + '</b><i>' + Games.SUIT_SYMBOL[Games.suitOf(card)] + '</i></span>';
  };

  // One WebSocket with automatic reconnect. hello() is re-sent on every (re)connect.
  Live.connect = function (options) {
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
  Live.staffKey = function () {
    var match = /(?:^|[#&])key=([^&]+)/.exec(location.hash);
    if (match) {
      Live.store.set('tdl-staff-key', decodeURIComponent(match[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    return Live.store.get('tdl-staff-key', '');
  };
  Live.askStaffKey = function (onKey, wrong) {
    var box = document.createElement('div');
    box.className = 'keygate';
    box.innerHTML = '<form><h2>輸入工作人員密碼</h2>' + (wrong ? '<p class="bad">密碼不對，請再輸入一次。</p>' : '<p>主持台與讀牌器需要密碼，部署時設定在 STAFF_KEY。</p>') +
      '<input id="keyInput" type="password" autocomplete="current-password" required><button class="primary" type="submit">進入</button></form>';
    document.body.appendChild(box);
    box.querySelector('form').addEventListener('submit', function (event) {
      event.preventDefault();
      var key = box.querySelector('input').value.trim();
      if (!key) return;
      Live.store.set('tdl-staff-key', key);
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

  Live.keepAwake = function () {
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(function () {}); } catch (error) { /* not available */ }
  };

  window.Live = Live;
})();
