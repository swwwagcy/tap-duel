// Reader: a phone above the table. It watches each card position, reads a card once it rests,
// and tells the server what it saw. It also sends a small picture of the table for viewers.
(function () {
  'use strict';
  var $ = Live.$, R = Recognizer;
  var TICK_MS = 140;               // about 7 frames a second
  var STILL_FRAMES = 3;            // a card must rest this many frames before it is read
  var READ_FRAMES = 3;             // frames averaged into one reading
  var EMPTY_FRAMES = 3;            // frames without a card before a position counts as empty
  var READ_ATTEMPTS = 3;           // an unsure reading is retried with fresh frames this many times
  var MIN_CARD_PX = 120;           // below this the camera is too far away to read reliably
  var FRAME_SEND_MS = 700;
  var WORK_MAX_WIDTH = 1280;

  var state = {
    tableId: ((/[?&]table=(\w+)/.exec(location.search) || [])[1] || Live.store.get('tdl-reader-table', 'duel')), mode: 'run',
    source: null, width: 0, height: 0, frame: null, empty: null, emptySigs: {},
    zones: {}, zoneState: {}, deck: Live.store.get('tdl-deck', {}), model: null,
    deckCard: null, lastRegistered: null, table: null,
    lastSize: 0, ticks: [], frameSentAt: 0, statusSentAt: 0, drag: null
  };
  var work = $('work'), workContext = null, overlay = $('overlay');
  var link = null;

  /* ---------------- connection ---------------- */
  function start(key) {
    link = Live.connect({
      hello: function () { return { t: 'hello', role: 'reader', key: key }; },
      onStatus: function (online) { if (!online) setPhase(null); },
      onMessage: function (message) {
        if (message.t === 'denied') { link.close(); Live.askStaffKey(start, true); return; }
        if (message.t === 'welcome') { buildTableTabs(message.tables); link.send({ t: 'watch', table: state.tableId }); if (/[?&]autostart\b/.test(location.search) && Live.demo && !state.source) autoStart(); }
        else if (message.t === 'table' && message.table.id === state.tableId) { state.table = message.table; setPhase(message.table); }
        else if (message.t === 'error') Live.toast(message.text, 'bad');
      }
    });
  }
  var key = Live.staffKey();
  if (key) start(key); else Live.askStaffKey(start);

  function send(message) { if (link && link.online) { message.table = state.tableId; link.send(message); } }
  function setPhase(table) {
    if (table) { autoDeal(table); learn(table); }
    $('phase').dataset.phase = table ? table.phase : 'idle';
    $('phase').textContent = table ? game().name + '・' + (table.phase === 'dealing' ? '出牌中' + (table.next ? '・下一張 ' + Games.zoneLabel(game(), table.next) : '') : Live.PHASE[table.phase]) : '未連線';
  }

  function game() { return Games.GAMES[state.tableId]; }

  function buildTableTabs(ids) {
    if (ids.indexOf(state.tableId) < 0) state.tableId = ids[0];
    $('tableTabs').innerHTML = ids.map(function (id) { return '<button type="button" data-table="' + id + '">' + Live.escape(Games.GAMES[id].name) + '</button>'; }).join('');
    $('tableTabs').querySelectorAll('button').forEach(function (button) {
      button.classList.toggle('on', button.dataset.table === state.tableId);
      button.addEventListener('click', function () {
        if (button.dataset.table === state.tableId) return;
        state.tableId = button.dataset.table; state.table = null;
        Live.store.set('tdl-reader-table', state.tableId);
        buildTableTabs(ids); loadTable();
        if (link) link.send({ t: 'watch', table: state.tableId });
      });
    });
  }

  /* ---------------- per-table setup: positions and the empty table ---------------- */
  function loadTable() {
    var stored = Live.store.get('tdl-zones-' + state.tableId, null), layout = game().layout;
    state.zones = {};
    game().zones.forEach(function (zone) { state.zones[zone.id] = (stored && stored[zone.id]) ? stored[zone.id].slice() : layout[zone.id].slice(); });
    resetZoneStates();
    state.empty = null; state.emptySigs = {};
    $('emptyText').textContent = '尚未拍空桌';
    var saved = Live.store.get('tdl-empty-' + state.tableId, null);
    if (saved && state.width) {
      var image = new Image();
      image.onload = function () {
        workContext.drawImage(image, 0, 0, state.width, state.height);
        state.empty = workContext.getImageData(0, 0, state.width, state.height);
        computeEmptySigs();
        $('emptyText').textContent = '空桌：' + new Date(saved.at).toLocaleString('zh-TW', { hour12: false }) + (saved.w !== state.width || saved.h !== state.height ? '（解析度不同，建議重拍）' : '');
      };
      image.src = saved.image;
    }
    buildReadouts(); renderDeck();
  }
  function resetZoneStates() {
    state.zoneState = {};
    game().zones.forEach(function (zone) { state.zoneState[zone.id] = { status: 'empty', still: 0, emptyCount: EMPTY_FRAMES, samples: [], prev: null, result: null, reported: 'empty' }; });
  }
  function rectOf(zoneId) {
    var z = state.zones[zoneId];
    return { x: z[0] * state.width, y: z[1] * state.height, w: z[2] * state.width, h: z[3] * state.height };
  }
  function computeEmptySigs() {
    state.emptySigs = {};
    if (!state.empty) return;
    game().zones.forEach(function (zone) { state.emptySigs[zone.id] = R.signature(state.empty, rectOf(zone.id)); });
  }
  function saveZones() { Live.store.set('tdl-zones-' + state.tableId, state.zones); computeEmptySigs(); resetZoneStates(); }

  /* ---------------- camera ---------------- */
  $('startCamera').addEventListener('click', function () {
    if (window.__readerSource) { useSource(window.__readerSource, window.__readerSource.width, window.__readerSource.height); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { Live.toast('這個瀏覽器不能開相機，需要 HTTPS 網址。', 'bad'); return; }
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }).then(function (stream) {
      var video = $('video');
      video.srcObject = stream;
      $('startCamera').disabled = true; $('startCamera').textContent = '相機啟動中…';
      var play = video.play();
      if (play && play.catch) play.catch(function () { /* waits for the size below either way */ });
      // Some browsers (iPhone Safari among them) report a 0x0 picture for a moment after the
      // stream starts. Starting with that size would break every frame afterwards, so wait.
      var started = Date.now();
      (function waitForSize() {
        if (video.videoWidth > 0 && video.videoHeight > 0) { useSource(video, video.videoWidth, video.videoHeight); return; }
        if (Date.now() - started > 8000) { $('startCamera').disabled = false; $('startCamera').textContent = '開始相機'; Live.toast('相機沒有畫面，請再按一次「開始相機」。', 'bad'); return; }
        requestAnimationFrame(waitForSize);
      })();
    }).catch(function (error) { Live.toast('無法開啟相機：' + error.name + '。請允許相機權限。', 'bad'); });
  });
  function useSource(source, sourceWidth, sourceHeight) {
    state.source = source;
    var scale = Math.min(1, WORK_MAX_WIDTH / sourceWidth);
    state.width = Math.round(sourceWidth * scale); state.height = Math.round(sourceHeight * scale);
    work.width = state.width; work.height = state.height;
    workContext = work.getContext('2d', { willReadFrequently: true });
    $('stage').style.aspectRatio = state.width + ' / ' + state.height;
    $('hint').hidden = true;
    $('video').hidden = source.tagName !== 'VIDEO';
    $('startCamera').textContent = '相機運行中'; $('startCamera').disabled = true;
    $('captureEmpty').disabled = false; $('captureEmpty').title = '';
    loadTable();
    if (!state.empty) $('emptyText').textContent = '清空桌面後按「拍空桌」';
    Live.keepAwake();
    tick();
  }

  $('captureEmpty').addEventListener('click', function () {
    if (!state.frame) { Live.toast('相機畫面還沒準備好，請稍等一下再按。', 'bad'); return; }
    state.empty = new ImageData(new Uint8ClampedArray(state.frame.data), state.width, state.height);
    computeEmptySigs(); resetZoneStates();
    var saved = { image: work.toDataURL('image/jpeg', 0.92), w: state.width, h: state.height, at: Date.now() };
    if (!Live.store.set('tdl-empty-' + state.tableId, saved)) Live.toast('空桌已拍，但這台裝置存不下，重新整理後要重拍。');
    $('emptyText').textContent = '空桌：剛剛拍好';
    Live.toast('已拍空桌。', 'good');
    renderDeck();
  });

  /* ---------------- main loop ---------------- */
  function tick() {
    var started = performance.now();
    if (state.source) {
      // One bad frame (a camera hiccup, a stream that briefly stops) must not stop the loop.
      try {
        workContext.drawImage(state.source, 0, 0, state.width, state.height);
        state.frame = workContext.getImageData(0, 0, state.width, state.height);
        process();
        drawOverlay();
        sendFrame();
        sendStatus();
        if (!state.readoutsAt || started - state.readoutsAt > 400) { state.readoutsAt = started; buildReadouts(); }
        state.ticks.push(started); while (state.ticks.length && started - state.ticks[0] > 2000) state.ticks.shift();
      } catch (error) {
        if (!state.loopErrorShown) { state.loopErrorShown = true; Live.toast('讀取相機畫面失敗：' + (error && error.message || error), 'bad'); }
      }
    }
    setTimeout(tick, Math.max(15, TICK_MS - (performance.now() - started)));
  }

  function process() {
    if (!state.empty) return;
    var frame = state.frame, defaults = R.DEFAULTS;
    game().zones.forEach(function (zone) {
      var zs = state.zoneState[zone.id], rect = rectOf(zone.id);
      var sig = R.signature(frame, rect), covered = R.coverage(sig, state.emptySigs[zone.id]);
      var moved = zs.prev ? R.motion(sig, zs.prev) : 99;
      zs.prev = sig; zs.coverage = covered; zs.moving = moved; zs.why = '';
      if (covered < defaults.presence * 0.5) {
        zs.still = 0; zs.samples = []; zs.attempts = 0;
        if (++zs.emptyCount >= EMPTY_FRAMES && zs.status !== 'empty') { zs.status = 'empty'; zs.result = null; report(zone.id, { state: 'empty' }); }
        return;
      }
      zs.emptyCount = 0;
      if (covered < defaults.presence) { zs.why = '變化太小，看不出有牌'; return; }
      if (moved > defaults.stillness) { zs.why = '畫面在動，等牌放穩'; }
      if (moved > defaults.stillness) { zs.still = 0; zs.samples = []; zs.attempts = 0; zs.status = 'busy'; return; }
      zs.still++;
      if (zs.status !== 'busy' && zs.status !== 'empty') return;      // this placement was already read
      if (zs.still < STILL_FRAMES) return;
      var found = R.locate(frame, state.empty, rect);
      if (!found) {
        zs.why = '找不到牌的輪廓（桌面太亮或光線變了？可以重拍空桌）';
        if (zs.still > STILL_FRAMES + 8) finish(zone.id, zs, rect, null);
        return;
      }
      state.lastSize = Math.round(found.h); zs.height = Math.round(found.h); zs.lightTable = !!found.lightTable;
      if (state.mode === 'deck') zs.samples.push(R.describeRaw(frame, found));
      else { zs.samples.push(R.describeProbe(frame, found)); zs.raws = (zs.raws || []).concat([R.describeRaw(frame, found)]).slice(-READ_FRAMES); }
      if (zs.samples.length >= READ_FRAMES) finish(zone.id, zs, rect, found);
    });
  }

  function finish(zoneId, zs, rect, found) {
    var samples = zs.samples; zs.samples = [];
    if (state.mode === 'deck') { register(zs, samples, found); return; }
    if (state.mode !== 'run') { zs.status = 'unsure'; return; }
    var shot = cropShot(rect);
    // What this reading saw, kept so the host's answer can teach the reader this card (see learn()).
    zs.learnRaw = found && zs.raws && zs.raws.length ? R.averageRaw(zs.raws) : null;
    var model = getModel();
    if (!found || !model) {
      zs.status = 'unsure'; zs.result = null;
      report(zoneId, { state: 'unsure', top: [], shot: shot });
      return;
    }
    var result = R.match(R.averageProbe(samples), model);
    // With part of the deck learned, the best match can only be a card already seen; a card not
    // learned yet would be forced onto its nearest neighbour. Until the deck covers every rank and
    // suit, a reading is only a suggestion for the host.
    if (!deckCovered()) { result.sure = false; result.partial = true; }
    zs.result = result;
    zs.attempts = (zs.attempts || 0) + 1;
    if (!result.sure && zs.attempts < READ_ATTEMPTS) { zs.status = 'busy'; return; }   // read again with fresh frames
    zs.status = result.sure ? 'card' : 'unsure';
    report(zoneId, result.sure
      ? { state: 'card', card: result.card, score: round(result.score), margin: round(result.margin), top: compactTop(result.top), shot: shot }
      : { state: 'unsure', top: compactTop(result.top), shot: shot });
  }
  function round(value) { return Math.round(value * 1000) / 1000; }
  function compactTop(top) { return (top || []).map(function (item) { return { card: item.card, score: round(item.score) }; }); }

  function report(zoneId, message) {
    var zs = state.zoneState[zoneId];
    var signature = message.state + ':' + (message.card || '');
    if (state.mode !== 'run') return;
    if (signature === zs.reported && message.state !== 'unsure') return;
    zs.reported = signature;
    message.t = 'zone'; message.zone = zoneId;
    send(message);
    buildReadouts();
  }

  function cropShot(rect) {
    var height = 120, width = Math.max(40, Math.round(height * rect.w / rect.h));
    var canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(work, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  var small = document.createElement('canvas');
  function sendFrame() {
    if (!link || !link.online || Date.now() - state.frameSentAt < FRAME_SEND_MS) return;
    state.frameSentAt = Date.now();
    small.width = 640; small.height = Math.round(640 * state.height / state.width);
    small.getContext('2d').drawImage(work, 0, 0, small.width, small.height);
    send({ t: 'frame', image: small.toDataURL('image/jpeg', 0.6) });
  }
  function sendStatus() {
    var fps = state.ticks.length / 2;
    var warnings = [];
    if (!state.empty) warnings.push('未拍空桌');
    if (!deckCovered()) warnings.push('學習中 ' + Object.keys(state.deck).length + '/52');
    if (state.lastSize && state.lastSize < MIN_CARD_PX) warnings.push('牌在畫面中太小');
    if (Live.awake !== 'on') warnings.push(Live.awake === 'unsupported' ? '這個瀏覽器無法保持螢幕常亮' : '螢幕常亮未開啟，點一下畫面');
    var text = fps.toFixed(0) + ' fps' + (state.lastSize ? '・牌高 ' + state.lastSize + 'px' : '') + (warnings.length ? '・' + warnings.join('・') : '');
    $('statusText').textContent = text;
    $('sizeText').innerHTML = state.lastSize && state.lastSize < MIN_CARD_PX ? '<span class="warn">牌太小，請把手機拉近（至少 ' + MIN_CARD_PX + 'px）</span>' : '';
    if (Date.now() - state.statusSentAt < 2000) return;
    state.statusSentAt = Date.now();
    send({ t: 'status', text: text });
  }

  /* ---------------- reference images of the deck ---------------- */

  // Enough of the deck to read on its own: every rank seen in at least two suits and every suit
  // seen in at least six ranks. Rank and suit are judged separately, so a card can be read before
  // that exact card has been learned, as long as its rank and its suit have been.
  function deckCovered() {
    var suitsPerRank = {}, ranksPerSuit = {};
    Object.keys(state.deck).forEach(function (card) {
      var rank = Games.rankOf(card), suit = Games.suitOf(card);
      suitsPerRank[rank] = (suitsPerRank[rank] || 0) + 1; ranksPerSuit[suit] = (ranksPerSuit[suit] || 0) + 1;
    });
    return Games.RANKS.every(function (rank) { return (suitsPerRank[rank] || 0) >= 2; }) && Games.SUITS.every(function (suit) { return (ranksPerSuit[suit] || 0) >= 6; });
  }

  // Learning by playing: when a round is confirmed, every card the host chose by hand becomes a
  // reference image (or improves one), using what the camera saw at that position.
  state.learnedRounds = {};
  function learn(table) {
    if (table.phase !== 'result' || !table.roundNo || state.learnedRounds[table.roundNo] || state.mode !== 'run') return;
    state.learnedRounds[table.roundNo] = true;
    var learned = [];
    Object.keys(table.cards || {}).forEach(function (zoneId) {
      var entry = table.cards[zoneId], zs = state.zoneState[zoneId];
      if (!entry || entry.source !== 'manual' || !entry.card || !zs || !zs.learnRaw) return;
      var existing = state.deck[entry.card];
      var raw = existing ? R.averageRaw([R.decodeRaw(existing), zs.learnRaw]) : zs.learnRaw;
      state.deck[entry.card] = R.encodeRaw(raw);
      zs.learnRaw = null;
      learned.push(Games.cardLabel(entry.card));
    });
    if (!learned.length) return;
    state.model = null;
    Live.store.set('tdl-deck', state.deck);
    renderDeck();
    Live.toast('已記住 ' + learned.join('、') + '（' + Object.keys(state.deck).length + ' / 52）', 'good');
  }
  function getModel() {
    if (state.model) return state.model;
    var entries = Object.keys(state.deck).map(function (card) { return { card: card, raw: R.decodeRaw(state.deck[card]) }; });
    if (!entries.length) return null;
    state.model = R.buildModel(entries);
    return state.model;
  }
  function nextUnregistered(after) {
    var cards = Games.allCards(), from = after ? cards.indexOf(after) + 1 : 0;
    for (var index = 0; index < cards.length; index++) {
      var card = cards[(from + index) % cards.length];
      if (!state.deck[card]) return card;
    }
    return null;
  }
  function register(zs, samples, found) {
    zs.status = 'done';
    if (!found || !state.deckCard) { Live.toast('找不到牌，請拿開再放一次。', 'bad'); return; }
    var card = state.deckCard;
    state.deck[card] = R.encodeRaw(R.averageRaw(samples));
    state.model = null;
    if (!Live.store.set('tdl-deck', state.deck)) Live.toast('這台裝置存不下牌組資料。', 'bad');
    state.lastRegistered = card;
    state.deckCard = nextUnregistered(card);
    Live.toast('已登記 ' + Games.cardLabel(card) + '，拿開後放下一張。', 'good');
    renderDeck();
  }
  function renderDeck() {
    var cards = Games.allCards(), count = Object.keys(state.deck).length;
    if (!state.deckCard || state.deck[state.deckCard]) state.deckCard = nextUnregistered(null);
    $('deckCount').textContent = '已登記 ' + count + ' / 52';
    $('deckGrid').innerHTML = cards.map(function (card) {
      return '<span class="' + (Games.isRed(card) ? 'red ' : '') + (state.deck[card] ? 'done ' : '') + (card === state.deckCard ? 'now' : '') + '">' + Games.cardLabel(card) + '</span>';
    }).join('');
    $('deckPrompt').textContent = !state.empty ? '先清空桌面按「拍空桌」，才能登記牌組。' : state.deckCard ? '請把 ' + Games.cardLabel(state.deckCard) + ' 放進任一牌位' : '52 張都登記好了，可以回到「運行」。';
  }
  $('deckSkip').addEventListener('click', function () { state.deckCard = nextUnregistered(state.deckCard); renderDeck(); });
  $('deckRedo').addEventListener('click', function () {
    if (!state.lastRegistered) return;
    delete state.deck[state.lastRegistered]; state.model = null; Live.store.set('tdl-deck', state.deck);
    state.deckCard = state.lastRegistered; state.lastRegistered = null; renderDeck();
  });
  var clearArmed = 0;
  $('deckClear').addEventListener('click', function () {
    if (Date.now() < clearArmed) { state.deck = {}; state.model = null; Live.store.set('tdl-deck', {}); clearArmed = 0; $('deckClear').textContent = '清除全部'; renderDeck(); return; }
    clearArmed = Date.now() + 3000; $('deckClear').textContent = '再按一次清除';
    setTimeout(function () { $('deckClear').textContent = '清除全部'; }, 3000);
  });

  /* ---------------- modes ---------------- */
  $('modeTabs').querySelectorAll('button').forEach(function (button) {
    button.addEventListener('click', function () {
      state.mode = button.dataset.mode;
      $('modeTabs').querySelectorAll('button').forEach(function (other) { other.classList.toggle('on', other === button); });
      $('panelRun').hidden = state.mode !== 'run'; $('panelZones').hidden = state.mode !== 'zones'; $('panelDeck').hidden = state.mode !== 'deck';
      resetZoneStates(); renderDeck();
    });
  });
  $('resetZones').addEventListener('click', function () {
    var layout = game().layout;
    game().zones.forEach(function (zone) { state.zones[zone.id] = layout[zone.id].slice(); });
    saveZones();
  });

  // What stops reading right now, in the order it has to be fixed. Shown above the positions.
  function blocker() {
    if (!state.source) return '還沒開始相機。';
    if (!state.empty) return '還沒拍空桌，讀牌尚未啟動：清空桌面後按「拍空桌」。';
    if (state.mode !== 'run') return '目前在「' + (state.mode === 'deck' ? '登記牌組' : '調整牌位') + '」，回到「運行」才會把牌送給主持台。';
    if (!link || !link.online) return '沒有連上伺服器，讀到的牌不會送出。';
    if (state.table && state.table.phase !== 'dealing') return '主持台的「' + game().name + '」還沒到出牌階段（目前：' + Live.PHASE[state.table.phase] + '）。讀到的牌會顯示在這裡，但要到出牌階段才會送出；主持台要選同一款遊戲。';
    return '';
  }
  // Each position shows its state and the numbers behind it, so a stalled step is visible.
  function buildReadouts() {
    var stop = blocker();
    $('blocker').hidden = !stop; $('blocker').textContent = stop;
    var count = Object.keys(state.deck).length;
    $('learning').hidden = !!stop || deckCovered();
    $('learning').textContent = '學習中：已記住 ' + count + ' / 52 張。認不出來的牌請主持台手選，確認結果後會自動記住；每個點數學過兩種花色、每種花色學過六個點數後就會自動讀牌。也可以到「登記牌組」一次登記完。';
    $('readouts').innerHTML = game().zones.map(function (zone) {
      var zs = state.zoneState[zone.id] || {};
      var card = zs.status === 'card' && zs.result ? zs.result.card : null;
      var text = zs.status === 'card' ? '認到 ' + Math.round(zs.result.score * 100) + '%' : zs.status === 'unsure' ? '認不出來' : zs.status === 'busy' ? '偵測中' : '空';
      var numbers = [];
      if (zs.coverage != null) numbers.push('覆蓋 ' + Math.round(zs.coverage * 100) + '%');
      if (zs.moving != null && zs.moving < 90) numbers.push('晃動 ' + zs.moving.toFixed(0));
      if (zs.height) numbers.push('牌高 ' + zs.height + 'px' + (zs.lightTable ? '（淺色桌面模式）' : ''));
      if (zs.result) numbers.push('最像 ' + Games.cardLabel(zs.result.card) + ' ' + zs.result.score.toFixed(2) + '／差距 ' + zs.result.margin.toFixed(2));
      return '<div class="readout ' + zone.side + '">' + Live.cardHtml(card) + '<div style="min-width:0"><div class="label">' + Live.escape(zone.label) + '　' + text + '</div>' +
        '<div class="diag">' + numbers.join('・') + '</div>' + (zs.why && zs.status !== 'card' ? '<div class="why">' + Live.escape(zs.why) + '</div>' : '') + '</div></div>';
    }).join('');
  }

  /* ---------------- overlay: positions, status, and dragging ---------------- */
  function drawOverlay() {
    var box = overlay.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    var width = Math.round(box.width * ratio), height = Math.round(box.height * ratio);
    if (overlay.width !== width || overlay.height !== height) { overlay.width = width; overlay.height = height; }
    var context = overlay.getContext('2d');
    context.clearRect(0, 0, width, height);
    if (state.source && state.source.tagName !== 'VIDEO') context.drawImage(work, 0, 0, width, height);
    var next = state.table && state.table.phase === 'dealing' ? state.table.next : null;
    game().zones.forEach(function (zone) {
      var z = state.zones[zone.id], zs = state.zoneState[zone.id] || {};
      var x = z[0] * width, y = z[1] * height, w = z[2] * width, h = z[3] * height;
      var colour = zs.status === 'card' || zs.status === 'done' ? '#37c58a' : zs.status === 'unsure' ? '#e9584c' : zs.status === 'busy' ? '#f2b23e' : 'rgba(255,255,255,0.7)';
      context.lineWidth = (next === zone.id ? 6 : 3) * ratio;
      context.strokeStyle = next === zone.id ? '#f2b23e' : colour;
      context.setLineDash(zs.status === 'empty' && next !== zone.id ? [8 * ratio, 6 * ratio] : []);
      context.strokeRect(x, y, w, h);
      context.setLineDash([]);
      context.font = 'bold ' + Math.round(14 * ratio) + 'px sans-serif';
      var label = zone.label + (zs.status === 'card' && zs.result ? ' ' + Games.cardLabel(zs.result.card) : zs.status === 'unsure' ? ' ?' : '');
      context.fillStyle = 'rgba(0,0,0,0.6)'; context.fillRect(x, y, context.measureText(label).width + 10 * ratio, 20 * ratio);
      context.fillStyle = colour; context.fillText(label, x + 5 * ratio, y + 15 * ratio);
      if (state.mode === 'zones') { context.fillStyle = '#f2b23e'; context.fillRect(x + w - 18 * ratio, y + h - 18 * ratio, 18 * ratio, 18 * ratio); }
    });
  }
  function pointerAt(event) {
    var box = overlay.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height, scaleX: 18 / box.width, scaleY: 18 / box.height };
  }
  overlay.addEventListener('pointerdown', function (event) {
    if (state.mode !== 'zones') return;
    var at = pointerAt(event), zones = game().zones.slice().reverse();
    for (var index = 0; index < zones.length; index++) {
      var z = state.zones[zones[index].id];
      var onHandle = at.x >= z[0] + z[2] - at.scaleX * 1.6 && at.x <= z[0] + z[2] + at.scaleX * 0.6 && at.y >= z[1] + z[3] - at.scaleY * 1.6 && at.y <= z[1] + z[3] + at.scaleY * 0.6;
      var inside = at.x >= z[0] && at.x <= z[0] + z[2] && at.y >= z[1] && at.y <= z[1] + z[3];
      if (onHandle || inside) {
        state.drag = { zone: zones[index].id, resize: onHandle, startX: at.x, startY: at.y, original: z.slice() };
        overlay.setPointerCapture(event.pointerId);
        return;
      }
    }
  });
  overlay.addEventListener('pointermove', function (event) {
    if (!state.drag) return;
    var at = pointerAt(event), drag = state.drag, z = drag.original.slice();
    var dx = at.x - drag.startX, dy = at.y - drag.startY;
    if (drag.resize) { z[2] = Math.max(0.04, Math.min(1 - z[0], z[2] + dx)); z[3] = Math.max(0.06, Math.min(1 - z[1], z[3] + dy)); }
    else { z[0] = Math.max(0, Math.min(1 - z[2], z[0] + dx)); z[1] = Math.max(0, Math.min(1 - z[3], z[1] + dy)); }
    state.zones[drag.zone] = z.map(function (value) { return Math.round(value * 1000) / 1000; });
    if (!state.source) drawOverlay();
  });
  overlay.addEventListener('pointerup', function () { if (state.drag) { state.drag = null; saveZones(); } });
  overlay.addEventListener('pointercancel', function () { state.drag = null; });

  /* ---------------- demo: simulated camera, quick registration, automatic dealing ---------------- */
  if (Live.demo) { $('fakeCamera').hidden = false; $('quickDeck').hidden = false; }
  function startFake() {
    state.fake = DemoCamera.source(1280, 720);
    useSource(state.fake.canvas, 1280, 720);
    $('fakeCamera').disabled = true;
    $('autoDealLabel').hidden = false;
  }
  $('fakeCamera').addEventListener('click', startFake);
  function cardHeightFor(zoneId) { var rect = rectOf(zoneId); return Math.min(rect.h * 0.78, rect.w * 0.78 / 0.716); }
  function zoneCentre(zoneId) { var rect = rectOf(zoneId); return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }

  // Builds reference images straight from the simulated cards (three noisy frames each), so the
  // demo does not need 52 manual placements. A real deck still goes through the normal flow.
  function quickRegister(done) {
    if (!state.width) { Live.toast('請先開始相機或模擬攝影機。', 'bad'); return; }
    var camera = DemoCamera.source(state.width, state.height, { still: true });
    var empty = camera.place([]), zoneId = game().zones[0].id, rect = rectOf(zoneId), centre = zoneCentre(zoneId), height = cardHeightFor(zoneId);
    var cards = Games.allCards(), index = 0;
    $('quickDeck').disabled = true;
    (function next() {
      if (index >= cards.length) {
        camera.stop(); state.model = null; Live.store.set('tdl-deck', state.deck); $('quickDeck').disabled = false;
        renderDeck(); Live.toast('52 張模擬牌已登記。', 'good'); if (done) done(); return;
      }
      var card = cards[index++], raws = [];
      for (var shot = 0; shot < 3; shot++) {
        var frame = camera.place([{ card: card, h: height, x: centre.x + (Math.random() - 0.5) * 8, y: centre.y + (Math.random() - 0.5) * 8, angle: (Math.random() - 0.5) * 0.04 }]);
        var found = R.locate(frame, empty, rect);
        if (found) raws.push(R.describeRaw(frame, found));
      }
      if (raws.length) state.deck[card] = R.encodeRaw(R.averageRaw(raws));
      $('deckCount').textContent = '登記中 ' + index + ' / 52';
      setTimeout(next, 0);
    })();
  }
  $('quickDeck').addEventListener('click', function () { quickRegister(); });

  // When the host's table asks for a card, put a random unused card on that position.
  state.dealt = {}; state.dealPending = false; state.shoe = [];
  function autoDeal(table) {
    if (!state.fake || !$('autoDeal').checked || state.mode !== 'run') return;
    if (table.phase === 'open' || table.phase === 'idle') {
      if (state.fake.placed().length) state.fake.place([]);
      state.dealt = {};
      return;
    }
    if (table.phase !== 'dealing' || !table.next || state.dealt[table.next] || state.dealPending) return;
    var zoneId = table.next;
    state.dealPending = true;
    setTimeout(function () {
      state.dealPending = false;
      if (!state.table || state.table.phase !== 'dealing' || state.table.next !== zoneId || state.dealt[zoneId]) return;
      var used = Object.keys(state.dealt).map(function (zone) { return state.dealt[zone]; }), card;
      do { if (!state.shoe.length) state.shoe = shuffle(Games.allCards()); card = state.shoe.pop(); } while (used.indexOf(card) >= 0);
      state.dealt[zoneId] = card;
      var centre = zoneCentre(zoneId), rect = rectOf(zoneId), height = cardHeightFor(zoneId);
      var list = state.fake.placed();
      list.push({ card: card, h: height, x: centre.x + (Math.random() - 0.5) * rect.w * 0.12, y: centre.y + (Math.random() - 0.5) * rect.h * 0.08, angle: (Math.random() - 0.5) * 0.12, flip: Math.random() < 0.5 });
      state.fake.place(list);
    }, 900);
  }
  function shuffle(list) { for (var index = list.length - 1; index > 0; index--) { var other = Math.floor(Math.random() * (index + 1)), keep = list[index]; list[index] = list[other]; list[other] = keep; } return list; }

  // demo.html opens the reader with ?autostart: simulated camera, empty table, deck, then run.
  function autoStart() {
    startFake();
    setTimeout(function () {
      $('captureEmpty').click();
      if (Object.keys(state.deck).length < 52) { state.deck = {}; quickRegister(); }
    }, 700);
  }

  loadTable();
  window.__readerState = state;   // read by the automated test
})();
