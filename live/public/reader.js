// Reader: a phone above the table. It watches each card position, reads a card once it rests
// (ocr.js: no deck registration, no photo of the empty table), and tells the server what it saw.
// It also sends a small picture of the table for viewers.
(function () {
  'use strict';
  var $ = Live.$, R = Recognizer;
  var TICK_MS = 140;               // about 7 frames a second
  var STILL_FRAMES = 3;            // a card must rest this many frames before it is read
  var READ_FRAMES = 3;             // separate frames read for one answer
  var EMPTY_FRAMES = 3;            // frames without a card before a position counts as empty
  var READ_ATTEMPTS = 3;           // an unsure answer is retried with fresh frames this many times
  var MIN_CARD_PX = 240;           // recommended card height in the picture
  var HARD_MIN_CARD_PX = 150;      // below this a reading is never trusted
  var SEARCH_MARGIN = 0.08;        // the card is looked for a little beyond the drawn frame
  var RETRY_TICKS = 10;            // a face-down or unread card is looked at again this often
  var FRAME_SEND_MS = 700;
  var WORK_MAX_WIDTH = 1920;
  var RAW_MAX_WIDTH = 2560;        // with a slanted camera, more of the camera's detail is kept before straightening
  var DEFAULT_QUAD = [[0.12, 0.14], [0.88, 0.14], [0.94, 0.88], [0.06, 0.88]];

  var state = {
    tableId: ((/[?&]table=(\w+)/.exec(location.search) || [])[1] || Live.store.get('tdl-reader-table', 'duel')), mode: 'run',
    source: null, width: 0, height: 0, frame: null,
    zones: {}, zoneState: {}, table: null,
    lastSize: 0, ticks: [], frameSentAt: 0, statusSentAt: 0, drag: null,
    zoom: Live.store.get('tdl-zoom', 1), track: null, lens: null, lastPhase: null,
    // Table calibration for a camera that is not straight above: the four corners of a rectangle
    // on the table (top-left, top-right, bottom-right, bottom-left), as fractions of the camera
    // picture. null = the camera looks straight down and the picture is used as it is.
    quad: validQuad(Live.store.get('tdl-quad', null)), quadDraft: null, sourceWidth: 0, sourceHeight: 0, rawWidth: 0, rawHeight: 0, flat: null
  };
  var work = $('work'), workContext = null, overlay = $('overlay');
  var raw = document.createElement('canvas'), rawContext = null;
  function validQuad(quad) {
    var ok = Array.isArray(quad) && quad.length === 4 && quad.every(function (point) { return Array.isArray(point) && point.length === 2 && isFinite(point[0]) && isFinite(point[1]); });
    return ok && Perspective.usable(quad) ? quad : null;
  }
  var link = null;

  /* ---------------- connection ---------------- */
  function start(key) {
    link = Live.connect({
      hello: function () { return { t: 'hello', role: 'reader', key: key }; },
      onStatus: function (online) { if (!online) setPhase(null); },
      onMessage: function (message) {
        if (message.t === 'denied') { link.close(); Live.askStaffKey(start, true); return; }
        if (message.t === 'welcome') { buildTableTabs(message.tables); link.send({ t: 'watch', table: state.tableId }); if (/[?&]autostart\b/.test(location.search) && Live.demo && !state.source) startFake(); }
        else if (message.t === 'table' && message.table.id === state.tableId) { state.table = message.table; setPhase(message.table); }
        else if (message.t === 'error') Live.toast(message.text, 'bad');
      }
    });
  }
  var key = Live.staffKey();
  if (key) start(key); else Live.askStaffKey(start);

  function send(message) { if (link && link.online) { message.table = state.tableId; link.send(message); } }
  function setPhase(table) {
    if (table) autoDeal(table);
    // The server only takes some states in some phases (a face-up card counts from dealing on),
    // so when the phase changes every position says again what it currently sees.
    if (table && table.phase !== state.lastPhase) {
      state.lastPhase = table.phase;
      Object.keys(state.zoneState).forEach(function (zoneId) {
        var zs = state.zoneState[zoneId];
        zs.reported = null;
        if (zs.lastMessage && zs.status !== 'empty') report(zoneId, Object.assign({}, zs.lastMessage));
      });
    }
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

  /* ---------------- per-table setup: where the card positions are ---------------- */
  function loadTable() {
    var stored = Live.store.get('tdl-zones-' + state.tableId, null), layout = game().layout;
    state.zones = {};
    game().zones.forEach(function (zone) { state.zones[zone.id] = (stored && stored[zone.id]) ? stored[zone.id].slice() : layout[zone.id].slice(); });
    resetZoneStates();
    buildReadouts();
  }
  function resetZoneStates() {
    state.zoneState = {};
    game().zones.forEach(function (zone) { state.zoneState[zone.id] = { status: 'empty', still: 0, wait: 0, emptyCount: EMPTY_FRAMES, reads: [], prev: null, result: null, reported: 'empty', lastMessage: null }; });
  }
  function rectOf(zoneId) {
    var z = state.zones[zoneId];
    return { x: z[0] * state.width, y: z[1] * state.height, w: z[2] * state.width, h: z[3] * state.height };
  }
  // The frame grown a little on every side: where the card is looked for, so a card that pokes
  // out of a tightly drawn frame is still found whole.
  function searchRect(zoneId) {
    var rect = rectOf(zoneId), dx = rect.w * SEARCH_MARGIN, dy = rect.h * SEARCH_MARGIN;
    var x0 = Math.max(0, rect.x - dx), y0 = Math.max(0, rect.y - dy);
    return { x: x0, y: y0, w: Math.min(state.width, rect.x + rect.w + dx) - x0, h: Math.min(state.height, rect.y + rect.h + dy) - y0 };
  }
  function saveZones() { Live.store.set('tdl-zones-' + state.tableId, state.zones); resetZoneStates(); }

  // The table's colour at one position, measured on every frame from the rim of the search area
  // (the darker half of it, so a card that reaches the rim does not count as table). This replaces
  // a stored photo of the empty table, and follows the light as it changes.
  var rimPixel = [0, 0, 0];
  function tableColour(frame, rect) {
    var samples = [], steps = 16, index;
    function take(x, y) {
      var px = Math.max(0, Math.min(frame.width - 1, x | 0)), py = Math.max(0, Math.min(frame.height - 1, y | 0)), at = (py * frame.width + px) * 4;
      samples.push([frame.data[at], frame.data[at + 1], frame.data[at + 2], frame.data[at] + frame.data[at + 1] + frame.data[at + 2]]);
    }
    for (index = 0; index < steps; index++) {
      var along = (index + 0.5) / steps;
      take(rect.x + along * rect.w, rect.y + 1); take(rect.x + along * rect.w, rect.y + rect.h - 2);
      take(rect.x + 1, rect.y + along * rect.h); take(rect.x + rect.w - 2, rect.y + along * rect.h);
    }
    samples.sort(function (a, b) { return a[3] - b[3]; });
    var half = samples.slice(0, samples.length >> 1), middle = half[half.length >> 1];
    rimPixel = [middle[0], middle[1], middle[2]];
    return rimPixel;
  }
  function flatSignature(colour, length) {
    var out = new Float32Array(length);
    for (var index = 0; index < length; index += 3) { out[index] = colour[0]; out[index + 1] = colour[1]; out[index + 2] = colour[2]; }
    return out;
  }

  /* ---------------- camera ---------------- */
  $('startCamera').addEventListener('click', function () {
    if (window.__readerSource) { useSource(window.__readerSource, window.__readerSource.width, window.__readerSource.height); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { Live.toast('這個瀏覽器不能開相機，需要 HTTPS 網址。', 'bad'); return; }
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } }).then(function (stream) {
      var video = $('video');
      state.track = stream.getVideoTracks()[0] || null;
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
    state.source = source; state.sourceWidth = sourceWidth; state.sourceHeight = sourceHeight;
    workContext = work.getContext('2d', { willReadFrequently: true });
    rawContext = raw.getContext('2d', { willReadFrequently: true });
    applyGeometry();
    $('hint').hidden = true;
    $('startCamera').textContent = '相機運行中'; $('startCamera').disabled = true;
    CardOCR.build();
    setupZoom();
    loadTable();
    Live.keepAwake();
    tick();
  }

  /* ---------------- geometry: straight above, or straightened from four corners ---------------- */
  function straightening() { return !!state.quad && state.mode !== 'quad'; }
  function quadPixels(quad) { return quad.map(function (point) { return [point[0] * state.rawWidth, point[1] * state.rawHeight]; }); }
  // Sets the size of the picture that is read. Straight above: the camera picture, scaled down
  // if it is very large. Calibrated: the table as seen from above, worked out from the corners.
  function applyGeometry() {
    if (!state.sourceWidth) return;
    var limit = straightening() ? RAW_MAX_WIDTH : WORK_MAX_WIDTH, scale = Math.min(1, limit / state.sourceWidth);
    state.rawWidth = Math.round(state.sourceWidth * scale); state.rawHeight = Math.round(state.sourceHeight * scale);
    if (straightening()) {
      var size = Perspective.outputSize(quadPixels(state.quad), state.rawWidth, state.rawHeight, WORK_MAX_WIDTH, WORK_MAX_WIDTH);
      raw.width = state.rawWidth; raw.height = state.rawHeight;
      state.width = size.width; state.height = size.height;
      state.flat = workContext.createImageData(size.width, size.height);
    } else {
      state.width = state.rawWidth; state.height = state.rawHeight; state.flat = null;
    }
    work.width = state.width; work.height = state.height;
    $('stage').style.aspectRatio = state.width + ' / ' + state.height;
    state.frame = null;
    resetZoneStates();
    showQuadState();
  }
  function showQuadState() {
    $('quadState').textContent = state.quad ? '目前：已校正，讀的是拉正後的桌面。' : '目前：未校正，直接使用相機畫面（鏡頭在正上方時用這個）。';
    $('quadOff').disabled = !state.quad;
  }
  function grabFrame() {
    if (!straightening()) {
      drawSource(workContext, state.width, state.height);
      return workContext.getImageData(0, 0, state.width, state.height);
    }
    drawSource(rawContext, state.rawWidth, state.rawHeight);
    Perspective.warp(rawContext.getImageData(0, 0, state.rawWidth, state.rawHeight), quadPixels(state.quad), state.flat);
    workContext.putImageData(state.flat, 0, 0);
    return state.flat;
  }

  /* ---------------- main loop ---------------- */
  function tick() {
    var started = performance.now();
    if (state.source) {
      // One bad frame (a camera hiccup, a stream that briefly stops) must not stop the loop.
      try {
        state.frame = grabFrame();
        if (state.mode !== 'quad') process();
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

  /* ---------------- zoom ---------------- */
  // The camera's own zoom is used where the browser offers it (it keeps full detail, and can go
  // wider than 1x on phones with a wide lens). Otherwise the middle of the picture is enlarged.
  function setupZoom() {
    var capabilities = null;
    try { capabilities = state.track && state.track.getCapabilities ? state.track.getCapabilities() : null; } catch (error) { capabilities = null; }
    state.lens = capabilities && capabilities.zoom && capabilities.zoom.max > capabilities.zoom.min ? { min: capabilities.zoom.min, max: Math.min(capabilities.zoom.max, 8) } : null;
    $('zoomBar').hidden = false;
    applyZoom(state.zoom);
  }
  function applyZoom(value) {
    var min = state.lens ? state.lens.min : 1, max = state.lens ? state.lens.max : 4;
    state.zoom = Math.round(Math.max(min, Math.min(max, value)) * 10) / 10;
    Live.store.set('tdl-zoom', state.zoom);
    $('zoomText').textContent = state.zoom.toFixed(1) + '×';
    $('zoomOut').disabled = state.zoom <= min; $('zoomIn').disabled = state.zoom >= max;
    if (state.lens) state.track.applyConstraints({ advanced: [{ zoom: state.zoom }] }).catch(function () { state.lens = null; applyZoom(Math.max(1, state.zoom)); });
    resetZoneStates();
    // The corners were marked on the picture at the old zoom.
    if (state.quad && state.zoomSeen != null && state.zoomSeen !== state.zoom && state.mode !== 'quad') Live.toast('縮放改變了，請到「桌面校正」重新對準四個角。', 'bad');
    state.zoomSeen = state.zoom;
  }
  $('zoomIn').addEventListener('click', function () { applyZoom(state.zoom + (state.zoom < 2 ? 0.1 : 0.2)); });
  $('zoomOut').addEventListener('click', function () { applyZoom(state.zoom - (state.zoom <= 2 ? 0.1 : 0.2)); });
  function drawSource(context, outWidth, outHeight) {
    var source = state.source, width = source.videoWidth || source.width, height = source.videoHeight || source.height;
    var crop = state.lens ? 1 : Math.max(1, state.zoom);
    var cropWidth = width / crop, cropHeight = height / crop;
    context.drawImage(source, (width - cropWidth) / 2, (height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, outWidth, outHeight);
  }

  function process() {
    var frame = state.frame, defaults = R.DEFAULTS;
    game().zones.forEach(function (zone) {
      var zs = state.zoneState[zone.id], rect = searchRect(zone.id);
      var table = tableColour(frame, rect);
      var sig = R.signature(frame, rect), covered = R.coverage(sig, flatSignature(table, sig.length));
      var moved = zs.prev ? R.motion(sig, zs.prev) : 99;
      zs.prev = sig; zs.coverage = covered; zs.moving = moved; zs.why = '';
      if (covered < defaults.presence * 0.5) {
        zs.still = 0; zs.reads = []; zs.attempts = 0; zs.height = 0;
        if (++zs.emptyCount >= EMPTY_FRAMES && zs.status !== 'empty') { zs.status = 'empty'; zs.result = null; report(zone.id, { state: 'empty' }); }
        return;
      }
      zs.emptyCount = 0;
      if (covered < defaults.presence) { zs.why = '變化太小，看不出有牌'; return; }
      if (moved > defaults.stillness) { zs.why = '畫面在動，等牌放穩'; zs.still = 0; zs.reads = []; zs.attempts = 0; zs.status = 'busy'; return; }
      zs.still++;
      if (zs.status === 'back' || zs.status === 'unsure') {
        // Face down or not read yet: look again every so often (a flip also shows up as movement).
        if (++zs.wait < RETRY_TICKS) return;
        zs.wait = 0; zs.attempts = READ_ATTEMPTS - 1; zs.reads = []; zs.again = true;
      } else if (zs.status !== 'busy' && zs.status !== 'empty') return;      // this placement was already read
      if (zs.still < STILL_FRAMES || state.mode !== 'run') return;
      var found = R.locate(frame, { colour: table }, rect);
      if (!found) {
        zs.why = '找不到牌的輪廓（牌和桌面的顏色太接近？）';
        if (zs.still > STILL_FRAMES + 8) finish(zone.id, zs, rect);
        return;
      }
      state.lastSize = Math.round(found.h); zs.height = Math.round(found.h);
      var reading = CardOCR.read(frame, found);
      if (found.h < HARD_MIN_CARD_PX) { reading.sure = false; reading.problem = 'card too small'; }
      zs.reads.push(reading);
      if (zs.reads.length >= READ_FRAMES) finish(zone.id, zs, rect);
    });
  }

  // Several frames were read separately. The card is accepted when at least two of them are sure
  // of the same card and none is sure of a different one.
  function decide(reads) {
    var votes = {}, lead = null;
    reads.forEach(function (reading) { if (reading.sure) votes[reading.card] = (votes[reading.card] || 0) + 1; });
    var cards = Object.keys(votes);
    var best = reads.filter(function (reading) { return reading.card; }).sort(function (a, b) { return b.score - a.score; })[0] || null;
    if (cards.length === 1 && votes[cards[0]] >= 2) lead = reads.filter(function (reading) { return reading.sure; })[0];
    var backs = reads.filter(function (reading) { return reading.back; }).length;
    return { sure: !!lead, back: !lead && !cards.length && backs * 2 > reads.length, reading: lead || best };
  }
  var PROBLEMS = { 'no index found': '找不到牌角的點數', 'no suit under the rank': '點數下方找不到花色', 'suit size does not fit the rank': '花色大小不合理', 'only one corner readable': '只有一個牌角讀得到', 'corners disagree': '兩個牌角讀到的不一樣', 'card too small': '牌在畫面中太小' };

  function finish(zoneId, zs, rect) {
    var reads = zs.reads; zs.reads = [];
    var verdict = decide(reads), reading = verdict.reading;
    zs.result = reading; zs.wait = 0;
    if (verdict.back) { zs.status = 'back'; zs.why = ''; zs.again = false; report(zoneId, { state: 'back' }); return; }
    zs.attempts = (zs.attempts || 0) + 1;
    if (!verdict.sure && zs.attempts < READ_ATTEMPTS) { zs.status = 'busy'; zs.still = 0; return; }   // read again with fresh frames
    zs.status = verdict.sure ? 'card' : 'unsure';
    if (!verdict.sure) zs.why = reading && reading.problem ? (PROBLEMS[reading.problem] || reading.problem) : reading ? '把握不夠' : '讀不到牌';
    var shot = cropShot(rectOf(zoneId));
    report(zoneId, verdict.sure
      ? { state: 'card', card: reading.card, score: round(reading.score), margin: round(reading.margin), top: compactTop(reading.top), shot: shot }
      : { state: 'unsure', top: compactTop(reading && reading.top), shot: shot });
  }
  function round(value) { return Math.round(value * 1000) / 1000; }
  function compactTop(top) { return (top || []).map(function (item) { return { card: item.card, score: round(item.score) }; }); }

  function report(zoneId, message) {
    var zs = state.zoneState[zoneId];
    var signature = message.state + ':' + (message.card || '');
    if (state.mode !== 'run') return;
    zs.lastMessage = message;
    if (signature === zs.reported) return;
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
    if (state.lastSize && state.lastSize < MIN_CARD_PX) warnings.push('牌在畫面中太小');
    if (Live.awake !== 'on') warnings.push(Live.awake === 'unsupported' ? '這個瀏覽器無法保持螢幕常亮' : '螢幕常亮未開啟，點一下畫面');
    var text = fps.toFixed(0) + ' fps' + (state.lastSize ? '・牌高 ' + state.lastSize + 'px' : '') + (warnings.length ? '・' + warnings.join('・') : '');
    $('statusText').textContent = text;
    $('sizeText').innerHTML = state.lastSize && state.lastSize < MIN_CARD_PX ? '<span class="warn">牌太小，請把手機拉近或把牌位排大一點（建議 ' + MIN_CARD_PX + 'px 以上）</span>' : '';
    if (Date.now() - state.statusSentAt < 2000) return;
    state.statusSentAt = Date.now();
    send({ t: 'status', text: text });
  }

  /* ---------------- modes ---------------- */
  $('modeTabs').querySelectorAll('button').forEach(function (button) {
    button.addEventListener('click', function () {
      state.mode = button.dataset.mode;
      $('modeTabs').querySelectorAll('button').forEach(function (other) { other.classList.toggle('on', other === button); });
      $('panelRun').hidden = state.mode !== 'run'; $('panelZones').hidden = state.mode !== 'zones'; $('panelQuad').hidden = state.mode !== 'quad';
      state.quadDraft = state.mode === 'quad' ? (state.quad || DEFAULT_QUAD).map(function (point) { return point.slice(); }) : null;
      applyGeometry();
      resetZoneStates();
    });
  });
  $('resetZones').addEventListener('click', function () {
    var layout = game().layout;
    game().zones.forEach(function (zone) { state.zones[zone.id] = layout[zone.id].slice(); });
    saveZones();
  });

  // What stops reading right now. Shown above the positions.
  function blocker() {
    if (!state.source) return '還沒開始相機。';
    if (state.mode !== 'run') return '目前在「' + (state.mode === 'quad' ? '桌面校正' : '調整牌位') + '」，回到「運行」才會讀牌。';
    if (!link || !link.online) return '沒有連上伺服器，讀到的牌不會送出。';
    if (state.table && state.table.phase !== 'dealing') return '主持台的「' + game().name + '」還沒到出牌階段（目前：' + Live.PHASE[state.table.phase] + '）。讀到的牌會顯示在這裡，但要到出牌階段才會送出；主持台要選同一款遊戲。';
    return '';
  }
  // Each position shows its state and the numbers behind it, so a stalled step is visible.
  function buildReadouts() {
    var stop = blocker();
    $('blocker').hidden = !stop; $('blocker').textContent = stop;
    $('readouts').innerHTML = game().zones.map(function (zone) {
      var zs = state.zoneState[zone.id] || {};
      var card = zs.status === 'card' && zs.result ? zs.result.card : null;
      var text = zs.status === 'card' ? '讀到 ' + Math.round(zs.result.score * 100) + '%' : zs.status === 'back' ? '牌背（未翻開）' : zs.status === 'unsure' ? '認不出來' : zs.status === 'busy' ? '偵測中' : '空';
      var numbers = [];
      if (zs.coverage != null) numbers.push('覆蓋 ' + Math.round(zs.coverage * 100) + '%');
      if (zs.moving != null && zs.moving < 90) numbers.push('晃動 ' + zs.moving.toFixed(0));
      if (zs.height) numbers.push('牌高 ' + zs.height + 'px');
      if (zs.result && zs.result.card) numbers.push('最像 ' + Games.cardLabel(zs.result.card) + ' ' + zs.result.score.toFixed(2) + '／差距 ' + zs.result.margin.toFixed(2));
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
    if (state.source) context.drawImage(work, 0, 0, width, height);   // what is read is what is shown, zoom included
    if (state.mode === 'quad') { drawQuad(context, width, height, ratio); return; }
    var next = state.table && state.table.phase === 'dealing' ? state.table.next : null;
    game().zones.forEach(function (zone) {
      var z = state.zones[zone.id], zs = state.zoneState[zone.id] || {};
      var x = z[0] * width, y = z[1] * height, w = z[2] * width, h = z[3] * height;
      var colour = zs.status === 'card' ? '#37c58a' : zs.status === 'back' ? '#4f8ff7' : zs.status === 'unsure' ? '#e9584c' : zs.status === 'busy' ? '#f2b23e' : 'rgba(255,255,255,0.7)';
      context.lineWidth = (next === zone.id ? 6 : 3) * ratio;
      context.strokeStyle = next === zone.id ? '#f2b23e' : colour;
      context.setLineDash(zs.status === 'empty' && next !== zone.id ? [8 * ratio, 6 * ratio] : []);
      context.strokeRect(x, y, w, h);
      context.setLineDash([]);
      context.font = 'bold ' + Math.round(14 * ratio) + 'px sans-serif';
      var label = zone.label + (zs.status === 'card' && zs.result ? ' ' + Games.cardLabel(zs.result.card) : zs.status === 'unsure' ? ' ?' : zs.status === 'back' ? ' 牌背' : '');
      context.fillStyle = 'rgba(0,0,0,0.6)'; context.fillRect(x, y, context.measureText(label).width + 10 * ratio, 20 * ratio);
      context.fillStyle = colour; context.fillText(label, x + 5 * ratio, y + 15 * ratio);
      if (state.mode === 'zones') { context.fillStyle = '#f2b23e'; context.fillRect(x + w - 18 * ratio, y + h - 18 * ratio, 18 * ratio, 18 * ratio); }
    });
  }
  // Calibration: the camera picture as it is, with the four corners to drag onto the corners of
  // the table mat (or of any rectangle lying flat on the table).
  var QUAD_NAMES = ['左上', '右上', '右下', '左下'];
  function drawQuad(context, width, height, ratio) {
    var quad = state.quadDraft || DEFAULT_QUAD, good = Perspective.usable(quad);
    context.lineWidth = 3 * ratio; context.strokeStyle = good ? '#f2b23e' : '#e9584c';
    context.fillStyle = 'rgba(242,178,62,0.12)';
    context.beginPath();
    quad.forEach(function (point, index) { if (index) context.lineTo(point[0] * width, point[1] * height); else context.moveTo(point[0] * width, point[1] * height); });
    context.closePath(); context.fill(); context.stroke();
    context.font = 'bold ' + Math.round(13 * ratio) + 'px sans-serif';
    quad.forEach(function (point, index) {
      var x = point[0] * width, y = point[1] * height;
      context.beginPath(); context.arc(x, y, 13 * ratio, 0, Math.PI * 2); context.fillStyle = 'rgba(0,0,0,0.55)'; context.fill();
      context.lineWidth = 3 * ratio; context.strokeStyle = '#f2b23e'; context.stroke();
      context.beginPath(); context.arc(x, y, 2.5 * ratio, 0, Math.PI * 2); context.fillStyle = '#f2b23e'; context.fill();
      context.fillStyle = '#fff'; context.fillText(QUAD_NAMES[index], x + (index === 1 || index === 2 ? -44 : 18) * ratio, y + (index < 2 ? 30 : -20) * ratio);
    });
  }
  function saveQuad(quad) {
    state.quad = quad ? quad.map(function (point) { return [Math.round(point[0] * 10000) / 10000, Math.round(point[1] * 10000) / 10000]; }) : null;
    if (state.quad) Live.store.set('tdl-quad', state.quad); else Live.store.remove('tdl-quad');
    state.zoomSeen = state.zoom;
    showQuadState();
  }
  $('quadOff').addEventListener('click', function () {
    saveQuad(null);
    state.quadDraft = DEFAULT_QUAD.map(function (point) { return point.slice(); });
    Live.toast('已取消校正，改回直接使用相機畫面。');
  });

  function pointerAt(event) {
    var box = overlay.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height, scaleX: 18 / box.width, scaleY: 18 / box.height };
  }
  overlay.addEventListener('pointerdown', function (event) {
    if (state.mode === 'quad' && state.quadDraft) {
      // The nearest corner, if the touch is reasonably close to it.
      var box = overlay.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top, nearest = -1, best = 60;
      state.quadDraft.forEach(function (point, index) { var gap = Math.hypot(point[0] * box.width - px, point[1] * box.height - py); if (gap < best) { best = gap; nearest = index; } });
      if (nearest >= 0) {
        state.drag = { corner: nearest, offsetX: state.quadDraft[nearest][0] - px / box.width, offsetY: state.quadDraft[nearest][1] - py / box.height, original: state.quadDraft.map(function (point) { return point.slice(); }) };
        overlay.setPointerCapture(event.pointerId);
      }
      return;
    }
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
    if (state.drag.corner != null) {
      var here = pointerAt(event);
      state.quadDraft[state.drag.corner] = [Math.max(0, Math.min(1, here.x + state.drag.offsetX)), Math.max(0, Math.min(1, here.y + state.drag.offsetY))];
      if (!state.source) drawOverlay();
      return;
    }
    var at = pointerAt(event), drag = state.drag, z = drag.original.slice();
    var dx = at.x - drag.startX, dy = at.y - drag.startY;
    if (drag.resize) { z[2] = Math.max(0.04, Math.min(1 - z[0], z[2] + dx)); z[3] = Math.max(0.06, Math.min(1 - z[1], z[3] + dy)); }
    else { z[0] = Math.max(0, Math.min(1 - z[2], z[0] + dx)); z[1] = Math.max(0, Math.min(1 - z[3], z[1] + dy)); }
    state.zones[drag.zone] = z.map(function (value) { return Math.round(value * 1000) / 1000; });
    if (!state.source) drawOverlay();
  });
  overlay.addEventListener('pointerup', function () {
    if (!state.drag) return;
    var drag = state.drag; state.drag = null;
    if (drag.corner == null) { saveZones(); return; }
    if (Perspective.usable(state.quadDraft)) saveQuad(state.quadDraft);
    else { state.quadDraft = drag.original; Live.toast('四個角要依序圍成一個不交叉的四邊形。', 'bad'); }
  });
  overlay.addEventListener('pointercancel', function () { state.drag = null; });

  /* ---------------- demo: simulated camera and automatic dealing ---------------- */
  if (Live.demo) $('fakeCamera').hidden = false;
  function startFake() {
    state.fake = DemoCamera.source(1920, 1080);
    useSource(state.fake.canvas, 1920, 1080);
    $('fakeCamera').disabled = true;
    $('autoDealLabel').hidden = false;
  }
  $('fakeCamera').addEventListener('click', startFake);
  function cardHeightFor(zoneId) { var rect = rectOf(zoneId); return Math.min(rect.h * 0.78, rect.w * 0.78 / 0.716); }
  function zoneCentre(zoneId) { var rect = rectOf(zoneId); return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }

  // When the host's table asks for a card, put a random unused card on that position.
  state.dealt = {}; state.dealPending = false; state.shoe = [];
  function autoDeal(table) {
    if (!state.fake || !$('autoDeal').checked || state.mode !== 'run') return;
    if (table.phase === 'open' || table.phase === 'idle') {
      if (state.fake.placed().length) state.fake.place([]);
      state.dealt = {};
      return;
    }
    // The simulated host clears the table a moment after the result, as a real one must.
    if ((table.phase === 'result' || table.phase === 'void') && state.fake.placed().length && !state.clearing) {
      state.clearing = true;
      setTimeout(function () { state.clearing = false; if (state.table && (state.table.phase === 'result' || state.table.phase === 'void')) { state.fake.place([]); state.dealt = {}; } }, 2500);
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

  loadTable();
  showQuadState();
  window.__readerState = state;   // read by the automated test
})();
