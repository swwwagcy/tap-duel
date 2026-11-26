// Viewer page: watch a table, choose spots during the countdown, see the result.
(function () {
  'use strict';
  var $ = Live.$;
  var me = Live.store.get('tdl-viewer', null);
  if (!me || !me.id) {
    me = { id: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36)), name: '' };
    Live.store.set('tdl-viewer', me);
  }
  var state = { tableId: ((/[?&]table=(\w+)/.exec(location.search) || [])[1] || Live.store.get('tdl-viewer-table', 'duel')), table: null, chips: [10, 50, 100, 500, 1000], chip: Live.store.get('tdl-viewer-chip', 100), points: null, picks: {}, refillBelow: 1000, lastResult: null, frameAt: 0 };

  var link = Live.connect({
    hello: function () { return { t: 'hello', role: 'viewer', viewerId: me.id, name: me.name, key: Live.staffKey() }; },
    onStatus: function (online) { if (online) link.send({ t: 'watch', table: state.tableId }); offlineBanner(!online); },
    onMessage: onMessage
  });

  function onMessage(message) {
    if (message.t === 'denied') { Live.viewerDenied(link, message); return; }
    if (message.t === 'welcome') {
      state.chips = message.chips || state.chips;
      state.refillBelow = message.refillBelow || state.refillBelow;
      if (state.chips.indexOf(state.chip) < 0) state.chip = state.chips[2] || state.chips[0];
      buildTabs(message.tables);
      buildChips();
    } else if (message.t === 'me') {
      state.points = message.points; state.picks = message.picks || {};
      me.name = message.name; Live.store.set('tdl-viewer', me);
      renderMe();
    } else if (message.t === 'table') {
      if (message.table.id !== state.tableId) return;
      var previous = state.table;
      state.table = message.table;
      if (!previous || previous.roundNo !== state.table.roundNo) { state.lastResult = null; }
      renderTable();
    } else if (message.t === 'frame') {
      if (message.table !== state.tableId) return;
      $('live').src = message.image; $('live').hidden = false; $('noFrame').hidden = true; state.frameAt = Date.now();
      fitStage();
    } else if (message.t === 'result') {
      if (message.table === state.tableId) { state.lastResult = message; renderBanner(); }
    } else if (message.t === 'error') {
      Live.toast(message.text, 'bad');
    }
  }

  function buildTabs(ids) {
    $('tableTabs').innerHTML = ids.map(function (id) { return '<button type="button" data-table="' + id + '">' + Live.escape(Games.GAMES[id].name) + '</button>'; }).join('');
    $('tableTabs').querySelectorAll('button').forEach(function (button) {
      button.addEventListener('click', function () { switchTable(button.dataset.table); });
    });
    if (ids.indexOf(state.tableId) < 0) state.tableId = ids[0];
    markTab();
    buildGame();
  }
  function markTab() {
    $('tableTabs').querySelectorAll('button').forEach(function (button) { button.classList.toggle('on', button.dataset.table === state.tableId); });
  }
  function switchTable(id) {
    if (id === state.tableId) return;
    state.tableId = id; state.table = null; state.lastResult = null;
    Live.store.set('tdl-viewer-table', id);
    $('live').hidden = true; $('noFrame').hidden = false;
    markTab(); buildGame();
    link.send({ t: 'watch', table: id });
  }

  function game() { return Games.GAMES[state.tableId]; }

  function buildGame() {
    var current = game();
    var sides = [{ side: 'red', title: '紅方' }, { side: 'blue', title: '藍方' }];
    if (current.id === 'nine') sides.reverse();
    $('hands').innerHTML = sides.map(function (item) {
      var zones = current.zones.filter(function (zone) { return zone.side === item.side; });
      return '<div class="hand ' + item.side + '" data-side="' + item.side + '"><h3>' + item.title + '</h3><div class="cards">' +
        zones.map(function (zone) { return '<span data-zone="' + zone.id + '">' + Live.cardHtml(null) + '</span>'; }).join('') + '</div><div class="total"></div></div>';
    }).join('');
    $('spots').innerHTML = current.spots.map(function (spot, index) {
      var wide = current.id === 'nine' && index >= 3;
      return '<button type="button" class="spot ' + spot.side + (wide ? ' wide' : '') + '" data-spot="' + spot.id + '"><span class="label">' + Live.escape(spot.label) + '</span><span class="odds">' + Live.escape(spot.odds) + '</span><span class="mine num"></span><span class="all num"></span></button>';
    }).join('');
    $('spots').querySelectorAll('.spot').forEach(function (button) {
      button.addEventListener('click', function () { link.send({ t: 'pick', table: state.tableId, spot: button.dataset.spot, amount: state.chip }); });
    });
    $('summary').textContent = current.summary;
    $('rules').innerHTML = current.rules.map(function (rule) { return '<li>' + Live.escape(rule) + '</li>'; }).join('');
    renderTable(); renderMe();
  }

  function buildChips() {
    $('chips').innerHTML = state.chips.map(function (value) { return '<button type="button" class="chip" data-chip="' + value + '">' + (value >= 1000 ? value / 1000 + 'K' : value) + '</button>'; }).join('');
    $('chips').querySelectorAll('.chip').forEach(function (button) {
      button.addEventListener('click', function () { state.chip = Number(button.dataset.chip); Live.store.set('tdl-viewer-chip', state.chip); markChip(); });
    });
    markChip();
  }
  function markChip() { $('chips').querySelectorAll('.chip').forEach(function (button) { button.classList.toggle('on', Number(button.dataset.chip) === state.chip); }); }

  function renderMe() {
    $('nameBtn').textContent = me.name || '觀眾';
    $('points').textContent = state.points == null ? '—' : state.points.toLocaleString('zh-TW');
    $('refill').hidden = !(state.points != null && state.points < state.refillBelow);
    var mine = state.picks[state.tableId] || {};
    $('spots').querySelectorAll('.spot').forEach(function (button) {
      var amount = mine[button.dataset.spot];
      button.querySelector('.mine').textContent = amount ? amount.toLocaleString('zh-TW') : '';
    });
    var open = state.table && state.table.phase === 'open';
    $('undo').disabled = !open || !Object.keys(mine).length;
  }

  function renderTable() {
    var table = state.table, current = game();
    if (!table) return;
    $('phase').dataset.phase = table.phase;
    $('phase').textContent = Live.PHASE[table.phase] || table.phase;
    $('round').textContent = table.roundNo ? '回合 ' + table.roundNo : '';
    var open = table.phase === 'open', share = {};
    Live.shareOf(current, table.totals).forEach(function (part) { share[part.id] = part; });
    $('spots').querySelectorAll('.spot').forEach(function (button) {
      button.disabled = !open;
      var total = table.totals[button.dataset.spot];
      var part = share[button.dataset.spot];
      button.querySelector('.all').textContent = total ? '全場 ' + total.toLocaleString('zh-TW') + (part ? '・' + part.percent + '%' : '') : '';
      button.classList.toggle('won', table.phase === 'result' && spotWon(button.dataset.spot));
    });
    current.zones.forEach(function (zone) {
      var slot = document.querySelector('[data-zone="' + zone.id + '"]');
      var entry = table.cards[zone.id];
      if (slot) slot.innerHTML = Live.cardHtml(entry && entry.back ? 'back' : entry && entry.card);
    });
    var outcome = table.outcome;
    document.querySelectorAll('.hand').forEach(function (hand) {
      var side = hand.dataset.side;
      var total = '';
      if (current.id === 'nine') {
        var values = current.zones.filter(function (zone) { return zone.side === side && table.cards[zone.id] && table.cards[zone.id].card; })
          .map(function (zone) { var index = Games.RANKS.indexOf(Games.rankOf(table.cards[zone.id].card)) + 1; return index >= 10 ? 0 : index; });
        if (values.length) total = values.reduce(function (a, b) { return a + b; }, 0) % 10 + ' 點';
      }
      hand.querySelector('.total').textContent = total;
      var winner = outcome && outcome.winner;
      hand.classList.toggle('win', table.phase === 'result' && ((side === 'red' && (winner === 'R' || winner === 'red')) || (side === 'blue' && (winner === 'U' || winner === 'blue'))));
    });
    $('road').innerHTML = Live.beadRoadHtml(table.road, 10);
    $('roadStats').innerHTML = Live.roadStatsHtml(table.road);
    $('share').innerHTML = Live.shareBarHtml(current, table.totals);
    if (table.phase === 'void') $('banner').innerHTML = '';
    renderBanner();
    renderMe();
    tick();
  }

  // The table picture keeps the reader's own shape (a phone held upright gives a tall picture)
  // and is always shown whole.
  $('live').addEventListener('load', fitStage);
  function fitStage() {
    var image = $('live');
    if (!image.naturalWidth) return;
    var ratio = image.naturalWidth / image.naturalHeight;
    document.querySelector('.stage').style.aspectRatio = String(Math.max(0.8, Math.min(1.9, ratio)));
  }

  function spotWon(spot) {
    var outcome = state.table.outcome;
    if (!outcome || outcome.winner == null) return false;
    return game().returned(spot, 100, outcome) > 100;
  }

  function renderBanner() {
    var table = state.table, banner = $('banner');
    if (!table) return;
    var text = '';
    if (table.phase === 'result' && table.outcome) text = table.outcome.text;
    if (table.phase === 'void') text = '本回合已取消，點數全數退回';
    if (state.lastResult && state.lastResult.roundNo === table.roundNo) {
      var net = state.lastResult.returned - state.lastResult.staked;
      text += (text ? '・' : '') + '投入 ' + state.lastResult.staked.toLocaleString('zh-TW') + '，取回 ' + state.lastResult.returned.toLocaleString('zh-TW') + '（' + (net >= 0 ? '+' : '') + net.toLocaleString('zh-TW') + '）';
    }
    banner.textContent = text;
    banner.classList.toggle('show', !!text);
  }

  function tick() {
    var table = state.table;
    if (!table) return;
    var counting = table.phase === 'open' || table.phase === 'closed';
    $('count').textContent = counting ? Live.secondsLeft(table.endsAt) : '';
    if (state.frameAt && Date.now() - state.frameAt > 6000) { $('live').hidden = true; $('noFrame').hidden = false; $('noFrame').textContent = '牌桌畫面暫時中斷'; }
  }
  setInterval(tick, 250);

  $('undo').addEventListener('click', function () { link.send({ t: 'undo', table: state.tableId }); });
  $('refill').addEventListener('click', function () { link.send({ t: 'refill' }); });
  $('nameBtn').addEventListener('click', function () { $('renameForm').hidden = !$('renameForm').hidden; $('nameInput').value = me.name || ''; if (!$('renameForm').hidden) $('nameInput').focus(); });
  $('renameForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var name = $('nameInput').value.trim();
    if (name) { me.name = name; Live.store.set('tdl-viewer', me); link.send({ t: 'rename', name: name }); }
    $('renameForm').hidden = true;
  });

  var offline = null;
  function offlineBanner(show) {
    if (show && !offline) { offline = document.createElement('div'); offline.className = 'offline'; offline.textContent = '連線中斷，正在重新連線…'; document.body.appendChild(offline); }
    if (!show && offline) { offline.remove(); offline = null; }
  }
})();
