// Viewer page as a half-height sheet under a live video. One table per page (?table=duel),
// chosen by whoever embeds it. No video here: the stream above shows the table, and card faces
// appear only when the server releases them (after the stream has had time to show the turn).
(function () {
  'use strict';
  var $ = Live.$;
  var me = Live.store.get('tdl-viewer', null);
  if (!me || !me.id) {
    me = { id: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36)), name: '' };
    Live.store.set('tdl-viewer', me);
  }
  var state = { tableId: (/[?&]table=(\w+)/.exec(location.search) || [])[1] || 'duel', table: null, chips: [10, 50, 100, 500, 1000], chip: Live.store.get('tdl-viewer-chip', 100), points: null, picks: {}, refillBelow: 1000, lastResult: null };

  var link = Live.connect({
    hello: function () { return { t: 'hello', role: 'viewer', viewerId: me.id, name: me.name }; },
    onStatus: function (online) { if (online) link.send({ t: 'watch', table: state.tableId }); offlineBanner(!online); },
    onMessage: onMessage
  });

  function onMessage(message) {
    if (message.t === 'welcome') {
      state.chips = message.chips || state.chips;
      state.refillBelow = message.refillBelow || state.refillBelow;
      if (state.chips.indexOf(state.chip) < 0) state.chip = state.chips[2] || state.chips[0];
      if ((message.tables || []).indexOf(state.tableId) < 0 && message.tables && message.tables.length) { state.tableId = message.tables[0]; link.send({ t: 'watch', table: state.tableId }); }
      buildGame(); buildChips();
    } else if (message.t === 'me') {
      state.points = message.points; state.picks = message.picks || {};
      renderMe();
    } else if (message.t === 'table') {
      if (message.table.id !== state.tableId) return;
      var previous = state.table;
      state.table = message.table;
      if (!previous || previous.roundNo !== state.table.roundNo) state.lastResult = null;
      renderTable();
    } else if (message.t === 'result') {
      if (message.table === state.tableId) { state.lastResult = message; renderMe(); }
    } else if (message.t === 'error') {
      Live.toast(message.text, 'bad');
    }
  }

  function game() { return Games.GAMES[state.tableId]; }

  function buildGame() {
    var current = game();
    var sides = [{ side: 'red', title: '紅方' }, { side: 'blue', title: '藍方' }];
    if (current.id === 'nine') sides.reverse();
    $('sheet').classList.toggle('nine', current.id === 'nine');
    $('hands').innerHTML = sides.map(function (item) {
      var zones = current.zones.filter(function (zone) { return zone.side === item.side; });
      return '<div class="hand ' + item.side + '" data-side="' + item.side + '"><h3><span>' + item.title + '</span><span class="total"></span></h3><div class="cards">' +
        zones.map(function (zone) { return '<span data-zone="' + zone.id + '" style="display:contents">' + Live.cardHtml(null) + '</span>'; }).join('') + '</div></div>';
    }).join('');
    $('spots').className = 'spots ' + current.id;
    $('spots').innerHTML = current.spots.map(function (spot, index) {
      var wide = current.id === 'nine' && index >= 3;
      return '<button type="button" class="spot ' + spot.side + (wide ? ' wide' : '') + '" data-spot="' + spot.id + '"><span class="label">' + Live.escape(spot.label) + '</span><span class="odds">' + Live.escape(spot.odds) + '</span><span class="all num"></span><span class="mine num"></span></button>';
    }).join('');
    $('spots').querySelectorAll('.spot').forEach(function (button) {
      button.addEventListener('click', function () { link.send({ t: 'pick', table: state.tableId, spot: button.dataset.spot, amount: state.chip }); });
    });
    $('helpTitle').textContent = current.name + '：玩法';
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

  function number(value) { return value.toLocaleString('zh-TW'); }

  function renderMe() {
    $('points').textContent = state.points == null ? '—' : number(state.points);
    $('refill').hidden = !(state.points != null && state.points < state.refillBelow);
    var mine = state.picks[state.tableId] || {}, staked = 0;
    $('spots').querySelectorAll('.spot').forEach(function (button) {
      var amount = mine[button.dataset.spot];
      if (amount) staked += amount;
      button.querySelector('.mine').textContent = amount ? number(amount) : '';
    });
    var table = state.table, open = table && table.phase === 'open';
    $('undo').disabled = !open || !Object.keys(mine).length;
    // The middle cell: what is on the table this round, then what the round came to.
    var net = $('net'), result = state.lastResult && table && state.lastResult.roundNo === table.roundNo && (table.phase === 'result' || table.phase === 'void') ? state.lastResult : null;
    net.className = '';
    if (result) {
      var gain = result.returned - result.staked;
      $('netLabel').textContent = '本回合結果';
      net.textContent = (gain > 0 ? '+' : gain < 0 ? '−' : '') + number(Math.abs(gain));
      if (gain > 0) net.className = 'up'; else if (gain < 0) net.className = 'down';
    } else {
      $('netLabel').textContent = '本回合投入';
      net.textContent = staked ? number(staked) : '—';
    }
  }

  function renderTable() {
    var table = state.table, current = game();
    if (!table) return;
    var phase = table.phase;
    $('stage').dataset.phase = phase;
    $('round').textContent = table.roundNo || '—';
    var open = phase === 'open';
    $('spots').querySelectorAll('.spot').forEach(function (button) {
      button.disabled = !open;
      var total = table.totals[button.dataset.spot];
      button.querySelector('.all').textContent = total ? '全場 ' + number(total) : '';
      button.classList.toggle('won', phase === 'result' && spotWon(button.dataset.spot));
    });
    var faces = 0;
    current.zones.forEach(function (zone) {
      var slot = document.querySelector('[data-zone="' + zone.id + '"]');
      var entry = table.cards[zone.id];
      if (entry && entry.card) faces++;
      // A card that is on the table but not yet released to viewers shows as a back.
      if (slot) slot.innerHTML = Live.cardHtml(entry && entry.card ? entry.card : entry ? 'back' : null);
    });
    var outcome = table.outcome;
    document.querySelectorAll('.hand').forEach(function (hand) {
      var side = hand.dataset.side, total = '';
      if (current.id === 'nine') {
        var values = current.zones.filter(function (zone) { return zone.side === side && table.cards[zone.id] && table.cards[zone.id].card; })
          .map(function (zone) { var index = Games.RANKS.indexOf(Games.rankOf(table.cards[zone.id].card)) + 1; return index >= 10 ? 0 : index; });
        if (values.length) total = values.reduce(function (a, b) { return a + b; }, 0) % 10 + ' 點';
      }
      hand.querySelector('.total').textContent = total;
      var winner = outcome && outcome.winner;
      hand.classList.toggle('win', phase === 'result' && ((side === 'red' && (winner === 'R' || winner === 'red')) || (side === 'blue' && (winner === 'U' || winner === 'blue'))));
    });
    $('watch').hidden = !(phase === 'dealing' && !faces);
    var road = table.road.slice(-16);
    $('road').innerHTML = road.length ? road.map(function (code) { return '<span class="' + code + '">' + (code === 'R' || code === 'red' ? '紅' : code === 'U' || code === 'blue' ? '藍' : '平') + '</span>'; }).join('') : '<span class="none">還沒有結果</span>';
    renderMe();
    tick();
  }

  function spotWon(spot) {
    var outcome = state.table.outcome;
    if (!outcome || outcome.winner == null) return false;
    return game().returned(spot, 100, outcome) > 100;
  }

  var PHASE_WORD = { idle: '待開始', open: '可以選擇', closed: '停止選擇', dealing: '出牌中', result: '結果', void: '已取消' };
  function tick() {
    var table = state.table;
    if (!table) return;
    var phase = table.phase, counting = phase === 'open' || phase === 'closed';
    $('count').textContent = counting ? Live.secondsLeft(table.endsAt) : phase === 'dealing' ? '出牌' : phase === 'result' ? (table.outcome ? shortResult(table.outcome) : '結果') : phase === 'void' ? '取消' : '—';
    $('phase').textContent = phase === 'void' ? '全數退回' : phase === 'result' ? '' : PHASE_WORD[phase] || '';
  }
  function shortResult(outcome) {
    var winner = outcome.winner;
    return winner === 'R' || winner === 'red' ? '紅方勝' : winner === 'U' || winner === 'blue' ? '藍方勝' : '平手';
  }
  setInterval(tick, 250);

  $('undo').addEventListener('click', function () { link.send({ t: 'undo', table: state.tableId }); });
  $('refill').addEventListener('click', function () { link.send({ t: 'refill' }); });
  $('helpButton').addEventListener('click', function () { $('help').hidden = false; });
  $('helpClose').addEventListener('click', function () { $('help').hidden = true; });

  var offline = null;
  function offlineBanner(show) {
    if (show && !offline) { offline = document.createElement('div'); offline.className = 'offline'; offline.textContent = '連線中斷，正在重新連線…'; document.body.appendChild(offline); }
    if (!show && offline) { offline.remove(); offline = null; }
  }
})();
