// The presenter's screen: read-only, in front of the person dealing, out of the stream's frame.
// It shows the countdown (early by the stream delay), each spot's total and how many chose it,
// and during dealing which position gets the next card. Everything it can do is watch.
(function () {
  'use strict';
  var $ = Live.$;
  var state = { tableId: (/[?&]table=(\w+)/.exec(location.search) || [])[1] || Live.store.get('tdl-stage-table', 'duel'), table: null, link: null };
  var LAST_SECONDS = 5;

  function start(key) {
    if (state.link) state.link.close();
    var link = state.link = Live.connect({
      hello: function () { return { t: 'hello', role: 'stage', key: key }; },
      onStatus: function (online) { if (online) link.send({ t: 'watch', table: state.tableId }); offline(!online); },
      onMessage: function (message) {
        if (message.t === 'denied') { link.close(); Live.askStaffKey(start, message.locked ? 'locked' : true); return; }
        if (message.t === 'welcome') buildTabs(message.tables);
        else if (message.t === 'table' && message.table.id === state.tableId) { state.table = message.table; render(); }
      }
    });
  }
  var key = Live.staffKey();
  if (key) start(key); else Live.askStaffKey(start);

  function game() { return Games.GAMES[state.tableId]; }

  function buildTabs(ids) {
    var list = (ids || Object.keys(Games.GAMES)).filter(function (id) { return Games.GAMES[id]; });
    if (list.indexOf(state.tableId) < 0) state.tableId = list[0];
    $('tableTabs').innerHTML = list.map(function (id) { return '<button type="button" data-table="' + id + '">' + Live.escape(Games.GAMES[id].name) + '</button>'; }).join('');
    $('tableTabs').querySelectorAll('button').forEach(function (button) {
      button.classList.toggle('on', button.dataset.table === state.tableId);
      button.addEventListener('click', function () { choose(button.dataset.table); });
    });
    buildSpots();
  }
  function choose(id) {
    state.tableId = id; state.table = null;
    Live.store.set('tdl-stage-table', id);
    $('tableTabs').querySelectorAll('button').forEach(function (button) { button.classList.toggle('on', button.dataset.table === id); });
    buildSpots();
    if (state.link) state.link.send({ t: 'watch', table: id });
  }

  function buildSpots() {
    $('spots').innerHTML = game().spots.map(function (spot) {
      return '<div class="spot ' + spot.side + '" data-spot="' + spot.id + '"><span class="label">' + Live.escape(spot.label) + '</span><span class="amount num">0</span><span class="people">0 人</span></div>';
    }).join('');
  }

  function number(value) { return (value || 0).toLocaleString('zh-TW'); }

  function render() {
    var table = state.table, current = game();
    if (!table) return;
    $('phase').dataset.phase = table.phase;
    $('phase').textContent = Live.PHASE[table.phase] || '';
    $('round').textContent = table.roundNo || '—';
    var people = table.spotPickers || {};
    $('spots').querySelectorAll('.spot').forEach(function (tile) {
      var id = tile.dataset.spot;
      tile.querySelector('.amount').textContent = number(table.totals[id]);
      tile.querySelector('.people').textContent = (people[id] || 0) + ' 人';
      tile.classList.toggle('won', table.phase === 'result' && !!table.outcome && current.returned(id, 100, table.outcome) > 100);
    });
    $('total').textContent = number(table.roundTotal);
    $('people').textContent = number(table.pickers);
    $('cards').innerHTML = current.zones.map(function (zone) {
      var entry = table.cards[zone.id];
      return '<span class="slot' + (table.next === zone.id ? ' next' : '') + '"><span>' + Live.escape(zone.label) + '</span>' + Live.cardHtml(entry && entry.card ? entry.card : entry ? 'back' : null) + '</span>';
    }).join('');
    tick();
  }

  // Seconds left as viewers will hear them: the server's deadline brought forward by the stream delay.
  function tick() {
    var table = state.table;
    if (!table) return;
    var clock = $('clock'), phase = table.phase, delay = (table.streamDelay || 0) * 1000;
    var count = '—', word = '', say = '';
    clock.dataset.phase = phase;
    clock.classList.remove('last');
    if (phase === 'open') {
      var left = Live.secondsLeft(table.endsAt ? table.endsAt - delay : 0);
      count = String(left);
      if (left === 0) { word = '請喊停'; say = '倒數已到，正在截止'; }
      else if (left <= LAST_SECONDS) { word = '最後 ' + left + ' 秒'; say = '催大家趕快選'; clock.classList.add('last'); }
      else { word = '觀眾選擇中'; say = '可以帶氣氛、催大家選擇'; }
      if (delay) say += '（已提前 ' + (delay / 1000) + ' 秒，配合直播延遲）';
    } else if (phase === 'closed') {
      count = '停'; word = '已截止'; say = '等主持台變綠再發牌';
    } else if (phase === 'dealing') {
      var next = table.next ? Games.zoneLabel(game(), table.next) : '';
      count = next || '等確認'; word = next ? '下一張發到這裡' : '牌到齊了'; say = next ? '' : '主持台核對後會確認';
    } else if (phase === 'result') {
      count = table.outcome ? table.outcome.text : '結果'; word = '結果'; say = '收牌後等主持台開下一回合';
    } else if (phase === 'void') {
      count = '取消'; word = '本回合取消'; say = '全數退回，等主持台開下一回合';
    } else {
      word = '等主持台開始';
    }
    $('count').textContent = count; $('word').textContent = word; $('say').textContent = say;
  }
  setInterval(tick, 250);

  var banner = null;
  function offline(show) {
    if (show && !banner) { banner = document.createElement('div'); banner.className = 'offline'; banner.textContent = '連線中斷，正在重新連線…'; document.body.appendChild(banner); }
    if (!show && banner) { banner.remove(); banner = null; }
  }
  Live.keepAwake();
})();
