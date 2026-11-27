// The single on-site page. Sign in (a scanned ticket, a session kept from before, or the staff
// key), choose the game, then switch between the views the sign-in allows: the host console, the
// presenter's screen and the card reader (a host session), or the presenter's screen alone (a
// presenter's session). The reader is mounted as a component: this page passes its readings on.
(function () {
  'use strict';
  var $ = Live.$;
  var SLOTS = ['tdl-staff-key', 'tdl-reader-key', 'tdl-stage-key'];
  var VIEW_NAME = { host: '主控台', stage: '主持人畫面', reader: '讀牌器' };
  var state = { key: null, role: null, tables: [], tableId: null, table: null, link: null, relay: null, reader: null, presenter: '' };
  var demoQuery = Live.demo && !/\.github\.io$/.test(location.hostname) ? '&demo' : Live.demo ? '&demo' : '';

  // Demo: this page runs the engine itself, as demo.html does, and the frames inside use it.
  if (Live.demo) window.__demoEngine = Engine.createEngine(Engine.DEMO_OPTIONS);

  function keep(key) { state.key = key; SLOTS.forEach(function (slot) { Live.store.set(slot, key); }); }
  function forget() { SLOTS.forEach(function (slot) { Live.store.remove(slot); }); state.key = null; }

  function signIn(key) {
    state.key = key;
    if (state.link) state.link.close();
    var link = state.link = Live.connect({
      hello: function () { return { t: 'hello', role: 'host', any: true, key: state.key }; },
      onStatus: function (online) { if (online && state.tableId) link.send({ t: 'watch', table: state.tableId }); },
      onMessage: function (message) {
        if (message.t === 'denied') {
          link.close();
          // A used ticket or a session that ran out: start over with the key, or a new code.
          if (/^(ticket|session):/.test(state.key || '')) forget();
          $('pickTitle').textContent = message.expired ? '登入碼已失效' : '需要登入';
          $('pickNote').textContent = message.expired ? '請重新掃一次新的登入碼，或輸入工作人員密碼。' : '';
          Live.askStaffKey(signIn, message.locked ? 'locked' : !message.expired);
          return;
        }
        if (message.t === 'welcome') {
          if (message.session) keep('session:' + message.session);      // the ticket is spent; the session is what this device keeps
          else if (!Live.demo) keep(state.key);
          state.role = message.role; state.tables = message.tables || []; state.presenter = message.presenter || '';
          if (state.tableId) return;                                   // a reconnect: the views are already up
          var wanted = (/[?&]table=(\w+)/.exec(location.search) || [])[1];
          if (wanted && state.tables.indexOf(wanted) >= 0) choose(wanted); else showPicker();
        } else if (message.t === 'table' && message.table.id === state.tableId) {
          state.table = message.table; renderWhere();
        }
      }
    });
  }

  function showPicker() {
    closeViews();
    $('bar').hidden = true;
    $('pick').classList.add('on');
    $('pickTitle').textContent = '選擇遊戲';
    $('games').innerHTML = state.tables.filter(function (id) { return Games.GAMES[id]; }).map(function (id) {
      return '<button type="button" data-table="' + id + '">' + Live.escape(Games.GAMES[id].name) + '<small>' + Games.GAMES[id].zones.length + ' 個牌位</small></button>';
    }).join('');
    $('games').querySelectorAll('button').forEach(function (button) { button.addEventListener('click', function () { choose(button.dataset.table); }); });
    $('pickNote').textContent = state.role === 'stage'
      ? '你是用主持人的登入碼進來的' + (state.presenter ? '（' + state.presenter + '）' : '') + '：選好遊戲後會顯示主持人畫面。'
      : '選好之後可以在主控台、主持人畫面、讀牌器之間切換；切走時讀牌器仍會繼續讀牌。';
  }

  function closeViews() {
    if (state.relay) { state.relay.close(); state.relay = null; }
    if (state.reader) { state.reader.destroy(); state.reader = null; }
    document.querySelectorAll('#views > .view:not(#pick)').forEach(function (view) { view.remove(); });
    state.tableId = null; state.table = null;
  }

  function addView(name) {
    var view = document.createElement('div');
    view.className = 'view'; view.dataset.view = name;
    $('views').appendChild(view);
    return view;
  }
  function framed(name, page) {
    var frame = document.createElement('iframe');
    frame.title = VIEW_NAME[name];
    frame.src = page + '?embed&table=' + state.tableId + demoQuery;
    addView(name).appendChild(frame);
  }

  function choose(tableId) {
    closeViews();
    state.tableId = tableId;
    $('pick').classList.remove('on');
    var views = state.role === 'stage' ? ['stage'] : ['host', 'stage', 'reader'];
    if (state.role !== 'stage') framed('host', 'host.html');
    framed('stage', 'stage.html');
    if (state.role !== 'stage') mountReader();
    $('viewTabs').innerHTML = views.length > 1 ? views.map(function (name) { return '<button type="button" data-view="' + name + '">' + VIEW_NAME[name] + '</button>'; }).join('') : '';
    $('viewTabs').querySelectorAll('button').forEach(function (button) { button.addEventListener('click', function () { show(button.dataset.view); }); });
    $('popOut').hidden = state.role === 'stage';
    $('bar').hidden = false;
    var last = Live.store.get('tdl-table-view', 'host');
    show(views.indexOf(last) >= 0 ? last : views[0]);
    state.link.send({ t: 'watch', table: tableId });
    renderWhere();
  }

  // The reader as a component: its readings go out on a connection signed in as the reader, and
  // the table's state comes back to it the same way.
  function mountReader() {
    var view = addView('reader');
    var relay = state.relay = Live.connect({
      hello: function () { return { t: 'hello', role: 'reader', key: state.key }; },
      onStatus: function (online) { if (online) relay.send({ t: 'watch', table: state.tableId }); },
      onMessage: function (message) {
        if (message.t === 'table' && message.table.id === state.tableId && state.reader) state.reader.setTable(message.table);
        else if (message.t === 'error') Live.toast(message.text, 'bad');
      }
    });
    state.reader = CardReader.mount(view, {
      game: state.tableId, demo: Live.demo, autostart: Live.demo,
      onReport: function (message) { if (relay.online) relay.send(message); }
    });
  }

  function show(name) {
    document.querySelectorAll('#views > .view:not(#pick)').forEach(function (view) { view.classList.toggle('on', view.dataset.view === name); });
    $('viewTabs').querySelectorAll('button').forEach(function (button) { button.classList.toggle('on', button.dataset.view === name); });
    Live.store.set('tdl-table-view', name);
  }

  function renderWhere() {
    var table = state.table, game = Games.GAMES[state.tableId];
    if (!game) { $('where').textContent = ''; return; }
    var open = table && table.tableOpen;
    $('where').innerHTML = '<span class="dot' + (open ? ' on' : '') + '"></span><b>' + Live.escape(game.name) + '</b>・' + (table ? (open ? '已開桌' : '還沒開桌') : '連線中') +
      (table && table.presenter ? '・主持人 ' + Live.escape(table.presenter) : '');
  }

  // The presenter's screen in a window of its own, to drag onto a second screen in front of the presenter.
  $('popOut').addEventListener('click', function () {
    var opened = window.open('stage.html?embed&table=' + state.tableId + demoQuery, 'tdl-stage', 'popup,width=1280,height=760');
    if (!opened) Live.toast('瀏覽器擋下了新視窗，請允許這個網站開啟彈出視窗。', 'bad');
  });
  $('changeGame').addEventListener('click', showPicker);

  /* ---------------- sign-in ---------------- */
  var ticket = /(?:^|[#&])ticket=([A-Za-z0-9]+)/.exec(location.hash);
  if (ticket) history.replaceState(null, '', location.pathname + location.search);
  if (Live.demo) signIn('demo');
  else if (ticket) signIn('ticket:' + ticket[1]);
  else {
    var key = Live.staffKey();
    if (key) signIn(key); else { $('pickTitle').textContent = '需要登入'; Live.askStaffKey(signIn); }
  }
  Live.keepAwake();
})();
