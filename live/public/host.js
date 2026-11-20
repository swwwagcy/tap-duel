// Host console: run the round, watch what the reader sees, correct any card by hand, confirm.
(function () {
  'use strict';
  var $ = Live.$;
  var state = { tableId: ((/[?&]table=(\w+)/.exec(location.search) || [])[1] || Live.store.get('tdl-host-table', 'duel')), table: null, tables: [], pickerZone: null, pickSuit: null, voidArmedUntil: 0, notes: [] };
  var link = null;

  function start(key) {
    link = Live.connect({
      hello: function () { return { t: 'hello', role: 'host', key: key }; },
      onStatus: function (online) { offlineBanner(!online); },
      onMessage: onMessage
    });
  }
  var key = Live.staffKey();
  if (key) start(key); else Live.askStaffKey(start);

  // Tell the host when the screen may turn off by itself.
  Live.onAwakeChange = function (value) {
    $('awakeState').hidden = value === 'on';
    $('awakeState').textContent = value === 'unsupported' ? '這個瀏覽器無法保持螢幕常亮，請把自動鎖定改成「永不」。' : '螢幕常亮未開啟：點一下畫面任何地方。';
  };

  function onMessage(message) {
    if (message.t === 'denied') { link.close(); Live.askStaffKey(start, true); return; }
    if (message.t === 'welcome') {
      state.tables = message.tables;
      if (state.tables.indexOf(state.tableId) < 0) state.tableId = state.tables[0];
      buildTabs(); buildZones();
      link.send({ t: 'watch', table: state.tableId });
      Live.keepAwake();
    } else if (message.t === 'table') {
      if (message.table.id !== state.tableId) return;
      state.table = message.table;
      render();
    } else if (message.t === 'frame') {
      if (message.table !== state.tableId) return;
      $('live').src = message.image; $('live').hidden = false;
    } else if (message.t === 'notice') {
      if (message.table === state.tableId) note(message.text, message.level);
    } else if (message.t === 'error') {
      Live.toast(message.text, 'bad');
    }
  }

  function game() { return Games.GAMES[state.tableId]; }

  function buildTabs() {
    $('tableTabs').innerHTML = state.tables.map(function (id) { return '<button type="button" data-table="' + id + '">' + Live.escape(Games.GAMES[id].name) + '</button>'; }).join('');
    $('tableTabs').querySelectorAll('button').forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.dataset.table === state.tableId) return;
        state.tableId = button.dataset.table; state.table = null; state.notes = [];
        Live.store.set('tdl-host-table', state.tableId);
        $('live').hidden = true; renderNotes();
        buildTabs(); buildZones();
        link.send({ t: 'watch', table: state.tableId });
      });
    });
    $('tableTabs').querySelectorAll('button').forEach(function (button) { button.classList.toggle('on', button.dataset.table === state.tableId); });
  }

  function buildZones() {
    var current = game(), box = $('zones');
    box.className = 'zones ' + current.id;
    var tile = function (zone) {
      return '<button type="button" class="zone ' + zone.side + '" data-zone="' + zone.id + '"><span class="name">' + Live.escape(zone.label) + '</span><span class="face"></span><span class="tag"></span><img class="shot" alt="" hidden></button>';
    };
    if (current.id === 'nine') {
      var blue = current.zones.filter(function (zone) { return zone.side === 'blue'; }), red = current.zones.filter(function (zone) { return zone.side === 'red'; });
      box.innerHTML = '<div class="sidehead blue"><span>藍方</span><span id="totalBlue"></span></div>' + blue.map(tile).join('') +
        '<div class="sidehead red"><span>紅方</span><span id="totalRed"></span></div>' + red.map(tile).join('');
    } else {
      box.innerHTML = current.zones.map(tile).join('');
    }
    box.querySelectorAll('.zone').forEach(function (button) { button.addEventListener('click', function () { openPicker(button.dataset.zone); }); });
    render();
  }

  function render() {
    var table = state.table, current = game();
    if (!table) return;
    var phase = table.phase;
    $('roundNo').textContent = table.roundNo || '—';
    $('phaseBox').dataset.phase = phase;
    $('phaseText').textContent = phase === 'result' && table.outcome ? table.outcome.text : phase === 'dealing' ? '可以出牌' : (Live.PHASE[phase] || phase);
    $('phaseSub').textContent = phase === 'closed' ? '還不要翻牌，等畫面變綠' : phase === 'open' ? '觀眾選擇中，牌先不要翻開' : '';

    var required = phase === 'dealing' ? current.required(cardsOf(table)) : current.zones.map(function (zone) { return zone.id; });
    current.zones.forEach(function (zone) {
      var button = document.querySelector('.zone[data-zone="' + zone.id + '"]');
      if (!button) return;
      var entry = table.cards[zone.id];
      button.querySelector('.face').innerHTML = Live.cardHtml(entry && entry.back ? 'back' : entry && entry.card);
      var tag = '';
      if (entry) {
        if (entry.back) tag = '牌背，等翻開';
        else if (entry.uncertain) tag = '認不出來，請點選';
        else if (entry.source === 'manual') tag = '手動';
        else tag = '光學 ' + Math.round((entry.score || 0) * 100) + '%';
        if (entry.conflict) tag = '重複的牌';
      } else if (table.next === zone.id) tag = '等這一張';
      button.querySelector('.tag').textContent = tag;
      var shot = button.querySelector('.shot');
      if (entry && entry.shot) { shot.src = entry.shot; shot.hidden = false; } else shot.hidden = true;
      button.classList.toggle('next', table.next === zone.id);
      button.classList.toggle('unsure', !!(entry && (entry.uncertain || entry.conflict)));
      button.classList.toggle('back', !!(entry && entry.back));
      button.classList.toggle('manual', !!(entry && entry.source === 'manual'));
      button.classList.toggle('off', phase === 'dealing' && required.indexOf(zone.id) < 0 && !entry);
      button.disabled = phase !== 'dealing';
    });
    if (current.id === 'nine') {
      var cards = cardsOf(table);
      $('totalBlue').textContent = sideTotal(cards, ['U1', 'U2', 'U3']);
      $('totalRed').textContent = sideTotal(cards, ['R1', 'R2', 'R3']);
    }
    renderGuide();
    renderTotals();
    $('readerState').textContent = table.readerOnline ? '讀牌器已連線' + (table.readerInfo && table.readerInfo.text ? '・' + table.readerInfo.text : '') : '讀牌器未連線（可手動選牌）';
    $('readerState').classList.toggle('offline', !table.readerOnline);
    renderButtons();
    renderHistory();
    if (!$('drawer').hidden) fillSettings();
    if (state.pickerZone) renderPicker();
    tick();
  }

  function cardsOf(table) {
    var out = {};
    Object.keys(table.cards).forEach(function (zone) { if (table.cards[zone].card) out[zone] = table.cards[zone].card; });
    return out;
  }
  function sideTotal(cards, zones) {
    var values = zones.filter(function (zone) { return cards[zone]; }).map(function (zone) { var index = Games.RANKS.indexOf(Games.rankOf(cards[zone])) + 1; return index >= 10 ? 0 : index; });
    return values.length ? values.reduce(function (a, b) { return a + b; }, 0) % 10 + ' 點' : '';
  }

  function renderGuide() {
    var table = state.table, guide = $('guide'), current = game();
    guide.classList.remove('bad');
    var stale = table.stale || [];
    if (stale.length) {
      guide.classList.add('bad');
      guide.textContent = '請先收掉桌上的牌：' + stale.map(function (zone) { return Games.zoneLabel(current, zone); }).join('、') + (table.auto ? '。收完會自動開下一回合。' : '。');
      return;
    }
    if (table.phase !== 'dealing') {
      guide.textContent = table.phase === 'idle' ? '按「開始新回合」開放觀眾選擇。' : table.phase === 'open' ? '倒數中。可以先把牌背面朝上放好，先不要翻開。' : table.phase === 'closed' ? '已截止，等待直播延遲過去。' : table.phase === 'result' ? '已結算。清桌後可開下一回合。' : '本回合已取消，點數已退回。';
      return;
    }
    var check = table.check;
    // What needs the host first: a card the reader could not read, then the next card to turn.
    var unread = current.zones.filter(function (zone) { var entry = table.cards[zone.id]; return entry && entry.uncertain; });
    if (unread.length) { guide.classList.add('bad'); guide.textContent = unread.map(function (zone) { return zone.label; }).join('、') + ' 認不出來：點那個牌位選牌。'; return; }
    if (table.next) {
      var waiting = table.cards[table.next] && table.cards[table.next].back;
      guide.textContent = (waiting ? '請翻開：' : '下一張：') + Games.zoneLabel(current, table.next); return;
    }
    if (check && check.ok) { guide.textContent = '牌已到齊，核對後按「確認結果」。'; return; }
    guide.classList.add('bad');
    if (check && check.duplicate) guide.textContent = Games.cardLabel(check.duplicate) + ' 出現兩次，請改正。';
    else if (check && check.extra.length) guide.textContent = '依規則不該有牌：' + check.extra.map(function (zone) { return Games.zoneLabel(current, zone); }).join('、') + '。請移除或取消回合。';
    else guide.textContent = '還有牌位需要處理。';
  }

  function renderTotals() {
    var table = state.table, current = game();
    var rows = current.spots.map(function (spot) { return '<div class="row"><span>' + Live.escape(spot.label) + '</span><span class="num">' + (table.totals[spot.id] || 0).toLocaleString('zh-TW') + '</span></div>'; }).join('');
    $('totals').innerHTML = '<div class="row muted"><span>本回合參與</span><span class="num">' + table.pickers + ' 人</span></div>' + rows;
  }

  function renderButtons() {
    var table = state.table, main = $('mainButton'), phase = table.phase;
    if (phase === 'idle' || phase === 'result' || phase === 'void') {
      var blocked = (table.stale || []).length > 0, armed = blocked && Date.now() < state.openArmedUntil;
      main.textContent = !blocked ? '開始新回合' : armed ? '再按一次：不收牌直接開始' : '桌上還有牌，先收掉';
      main.disabled = false;
    }
    else if (phase === 'dealing') { main.textContent = '確認結果'; main.disabled = !(table.check && table.check.ok); }
    else { main.textContent = '等待截止'; main.disabled = true; }
    var canVoid = phase === 'open' || phase === 'closed' || phase === 'dealing';
    var armed = canVoid && Date.now() < state.voidArmedUntil;
    $('voidButton').disabled = !canVoid;
    $('voidButton').classList.toggle('armed', armed);
    $('voidButton').textContent = armed ? '再按一次取消' : '取消回合';
  }

  function renderHistory() {
    var table = state.table, current = game();
    if (!table.history || !table.history.length) { $('history').innerHTML = '<p class="muted">還沒有結束的回合。</p>'; return; }
    $('history').innerHTML = table.history.map(function (entry) {
      var cards = current.zones.filter(function (zone) { return entry.cards[zone.id] && entry.cards[zone.id].card; }).map(function (zone) {
        var card = entry.cards[zone.id];
        return '<div class="c">' + (card.shot ? '<img alt="" src="' + card.shot + '">' : '') + '<span>' + Live.escape(zone.label) + ' ' + Games.cardLabel(card.card) + '</span><span>' + (card.source === 'manual' ? '手動' : '光學 ' + Math.round((card.score || 0) * 100) + '%') + '</span></div>';
      }).join('');
      var time = new Date(entry.at);
      return '<div class="hist"><b>' + Live.escape(entry.roundNo) + '</b>　' + Live.escape(entry.text) + '<span class="muted">　' + time.toLocaleTimeString('zh-TW', { hour12: false }) + '・投入 ' + entry.staked + '、取回 ' + entry.returned + '</span><div class="cards">' + cards + '</div></div>';
    }).join('');
  }

  function tick() {
    var table = state.table;
    if (!table) return;
    var counting = table.phase === 'open' || table.phase === 'closed' || ((table.phase === 'result' || table.phase === 'void') && table.auto);
    $('count').textContent = counting ? Live.secondsLeft(table.endsAt) : '';
    if (state.voidArmedUntil && Date.now() > state.voidArmedUntil) { state.voidArmedUntil = 0; renderButtons(); }
    if (state.openArmedUntil && Date.now() > state.openArmedUntil) { state.openArmedUntil = 0; renderButtons(); }
    if ((table.stale || []).length) $('count').textContent = '';
  }
  setInterval(tick, 250);

  /* ---------------- manual card picker ---------------- */
  function openPicker(zone) {
    if (!state.table || state.table.phase !== 'dealing') return;
    state.pickerZone = zone; state.pickSuit = null;
    $('picker').hidden = false;
    renderPicker();
  }
  function renderPicker() {
    var zone = state.pickerZone, entry = state.table.cards[zone];
    $('pickerTitle').textContent = Games.zoneLabel(game(), zone) + (entry && entry.card ? '：目前是 ' + Games.cardLabel(entry.card) : '：選牌');
    var quick = entry && entry.top ? entry.top : [];
    $('pickerQuick').innerHTML = quick.map(function (item) { return '<button type="button" data-card="' + item.card + '">' + Games.cardLabel(item.card) + ' <span class="muted">' + Math.round(item.score * 100) + '%</span></button>'; }).join('');
    $('pickerQuick').hidden = !quick.length;
    $('pickerShot').hidden = !(entry && entry.shot);
    if (entry && entry.shot) $('pickerShot').src = entry.shot;
    $('pickerSuits').innerHTML = Games.SUITS.map(function (suit) { return '<button type="button" class="' + (suit === 'H' || suit === 'D' ? 'red' : '') + (state.pickSuit === suit ? ' on' : '') + '" data-suit="' + suit + '">' + Games.SUIT_SYMBOL[suit] + '</button>'; }).join('');
    $('pickerRanks').innerHTML = Games.RANKS.map(function (rank) { return '<button type="button" data-rank="' + rank + '"' + (state.pickSuit ? '' : ' disabled') + '>' + rank + '</button>'; }).join('');
  }
  $('picker').addEventListener('click', function (event) {
    var target = event.target.closest('button');
    if (event.target === $('picker')) { closePicker(); return; }
    if (!target) return;
    if (target.dataset.card) { setCard(target.dataset.card); return; }
    if (target.dataset.suit) { state.pickSuit = target.dataset.suit; renderPicker(); return; }
    if (target.dataset.rank && state.pickSuit) { setCard(state.pickSuit + target.dataset.rank); return; }
  });
  function setCard(card) { link.send({ t: 'setCard', table: state.tableId, zone: state.pickerZone, card: card }); closePicker(); }
  function closePicker() { state.pickerZone = null; $('picker').hidden = true; }
  $('pickerClear').addEventListener('click', function () { link.send({ t: 'setCard', table: state.tableId, zone: state.pickerZone, card: null }); closePicker(); });
  $('pickerClose').addEventListener('click', closePicker);

  /* ---------------- actions ---------------- */
  function primary() {
    var table = state.table;
    if (!table || $('mainButton').disabled) return;
    if (table.phase === 'dealing') link.send({ t: 'confirm', table: state.tableId });
    else if ((table.stale || []).length) {
      // Old cards still on the table: the first press only warns, a second one within 3 s overrides.
      if (Date.now() < state.openArmedUntil) { state.openArmedUntil = 0; link.send({ t: 'open', table: state.tableId, force: true }); }
      else { state.openArmedUntil = Date.now() + 3000; renderButtons(); }
    }
    else link.send({ t: 'open', table: state.tableId });
  }
  $('mainButton').addEventListener('click', primary);
  $('voidButton').addEventListener('click', function () {
    if (Date.now() < state.voidArmedUntil) { state.voidArmedUntil = 0; link.send({ t: 'void', table: state.tableId }); }
    else state.voidArmedUntil = Date.now() + 3000;
    renderButtons();
  });
  document.addEventListener('keydown', function (event) {
    if (event.target.matches && event.target.matches('input, select, textarea')) return;
    if (!$('picker').hidden || !$('drawer').hidden) return;
    if (event.key === 'Enter' || event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); primary(); }
  });
  $('helpButton').addEventListener('click', function () { Live.toast('Enter、PageDown 或右方向鍵＝主按鈕。點牌位可以手動改牌。'); });

  /* ---------------- settings drawer ---------------- */
  function fillSettings() {
    var settings = state.table && state.table.settings;
    if (!settings) return;
    if (document.activeElement !== $('setOpen')) $('setOpen').value = settings.openSeconds;
    if (document.activeElement !== $('setWait')) $('setWait').value = settings.waitSeconds;
    $('setAuto').checked = settings.auto;
  }
  function sendSettings() { link.send({ t: 'settings', table: state.tableId, openSeconds: $('setOpen').value, waitSeconds: $('setWait').value, auto: $('setAuto').checked }); }
  ['setOpen', 'setWait', 'setAuto'].forEach(function (id) { $(id).addEventListener('change', sendSettings); });
  $('openDrawer').addEventListener('click', function () { $('drawer').hidden = false; fillSettings(); renderHistory(); });
  $('closeDrawer').addEventListener('click', function () { $('drawer').hidden = true; });

  function note(text, level) {
    state.notes.unshift({ text: text, level: level, at: Date.now() });
    if (state.notes.length > 20) state.notes.length = 20;
    renderNotes();
    // The note list is hidden on narrow screens; only then does the message need to pop up.
    if (!$('notes').offsetParent && $('picker').hidden) Live.toast(text, level === 'warn' ? '' : 'good');
  }
  function renderNotes() {
    $('notes').innerHTML = state.notes.length ? state.notes.map(function (item) { return '<p class="' + (item.level || '') + '">' + new Date(item.at).toLocaleTimeString('zh-TW', { hour12: false }) + '　' + Live.escape(item.text) + '</p>'; }).join('') : '<p class="muted">提醒會顯示在這裡。</p>';
  }

  var offline = null;
  function offlineBanner(show) {
    if (show && !offline) { offline = document.createElement('div'); offline.className = 'offline'; offline.textContent = '連線中斷，正在重新連線…'; document.body.appendChild(offline); }
    if (!show && offline) { offline.remove(); offline = null; }
  }
})();
