// Tap Duel Live: one process holds every table, every viewer's points and the round state.
// It is the only place that decides when a round opens or closes and what each pick returns.
// State lives in memory, so run it as a single instance (see README).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Games = require('./public/games.js');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STAFF_KEY = process.env.STAFF_KEY || crypto.randomBytes(4).toString('hex');
if (!process.env.STAFF_KEY) console.log('STAFF_KEY is not set; this run uses the generated key: ' + STAFF_KEY);

const CHIPS = [10, 50, 100, 500, 1000];
const START_POINTS = 10000;
const REFILL_BELOW = 1000;
const SPOT_LIMIT = 20000;          // most points one viewer may put on one spot in one round
const RESULT_HOLD_MS = 6000;       // how long a finished round stays on screen before an automatic next round
const READER_TIMEOUT_MS = 5000;
const FRAME_INTERVAL_MS = 400;
const HISTORY_LIMIT = 30;
const ROAD_LIMIT = 60;

/* ------------------------------------------------------------------ state */

const tables = {};
Object.keys(Games.GAMES).forEach(function (id) {
  tables[id] = {
    id: id,
    game: Games.GAMES[id],
    phase: 'idle',          // idle | open | closed | dealing | result | void
    sequence: 0,
    round: null,
    endsAt: 0,
    settings: { openSeconds: 15, waitSeconds: 3, auto: false },
    history: [],
    road: [],
    frame: null,
    frameSentAt: 0,
    readerSeenAt: 0,
    readerInfo: null
  };
});
const viewers = new Map();           // viewerId -> { id, name, points }
const sockets = new Set();           // every open connection

function newRound(table) {
  const now = new Date();
  table.sequence += 1;
  const day = String(now.getUTCFullYear()).slice(2) + String(now.getUTCMonth() + 1).padStart(2, '0') + String(now.getUTCDate()).padStart(2, '0');
  return {
    no: table.id.toUpperCase() + '-' + day + '-' + String(table.sequence).padStart(3, '0'),
    picks: new Map(),       // viewerId -> [{ spot, amount }] in the order they were made
    cards: {},              // zone -> { card, source, score, margin, top, shot, uncertain, at }
    warned: {},
    outcome: null,
    openedAt: Date.now()
  };
}

function cardMap(round) {
  const out = {};
  Object.keys(round.cards).forEach(function (zone) { if (round.cards[zone].card) out[zone] = round.cards[zone].card; });
  return out;
}

/* ------------------------------------------------------------------ messages out */

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function totalsOf(round) {
  const totals = {};
  if (!round) return totals;
  round.picks.forEach(function (list) { list.forEach(function (pick) { totals[pick.spot] = (totals[pick.spot] || 0) + pick.amount; }); });
  return totals;
}

function tableView(table, role) {
  const round = table.round;
  const cards = {};
  if (round) {
    Object.keys(round.cards).forEach(function (zone) {
      const entry = round.cards[zone];
      cards[zone] = role === 'viewer'
        ? { card: entry.card, source: entry.source }
        : { card: entry.card, source: entry.source, score: entry.score, margin: entry.margin, top: entry.top, shot: entry.shot, uncertain: entry.uncertain, conflict: entry.conflict };
    });
  }
  const view = {
    id: table.id,
    phase: table.phase,
    roundNo: round ? round.no : null,
    endsAt: table.endsAt,
    serverNow: Date.now(),
    cards: cards,
    next: round && table.phase === 'dealing' ? Games.nextZone(table.game, cardMap(round)) : null,
    outcome: round ? round.outcome : null,
    road: table.road,
    totals: totalsOf(round),
    pickers: round ? round.picks.size : 0,
    readerOnline: Date.now() - table.readerSeenAt < READER_TIMEOUT_MS,
    auto: table.settings.auto
  };
  if (role !== 'viewer') {
    view.settings = table.settings;
    view.history = table.history;
    view.readerInfo = table.readerInfo;
    view.check = round && (table.phase === 'dealing') ? Games.checkComplete(table.game, cardMap(round)) : null;
  }
  return view;
}

function broadcastTable(table) {
  sockets.forEach(function (socket) {
    if (!socket.role || socket.watching !== table.id) return;
    send(socket, { t: 'table', table: tableView(table, socket.role === 'viewer' ? 'viewer' : 'staff') });
  });
}

function notifyStaff(table, level, text) {
  sockets.forEach(function (socket) {
    if (socket.role === 'host' && socket.watching === table.id) send(socket, { t: 'notice', table: table.id, level: level, text: text });
  });
}

function sendMe(viewerId) {
  const viewer = viewers.get(viewerId);
  if (!viewer) return;
  const picks = {};
  Object.keys(tables).forEach(function (id) {
    const round = tables[id].round;
    const list = round && round.picks.get(viewerId);
    if (!list) return;
    picks[id] = {};
    list.forEach(function (pick) { picks[id][pick.spot] = (picks[id][pick.spot] || 0) + pick.amount; });
  });
  sockets.forEach(function (socket) {
    if (socket.role === 'viewer' && socket.viewerId === viewerId) send(socket, { t: 'me', id: viewer.id, name: viewer.name, points: viewer.points, picks: picks });
  });
}

function sendToViewer(viewerId, message) {
  sockets.forEach(function (socket) { if (socket.role === 'viewer' && socket.viewerId === viewerId) send(socket, message); });
}

/* ------------------------------------------------------------------ round flow */

function openRound(table) {
  if (['idle', 'result', 'void'].indexOf(table.phase) < 0) return '這一回合還沒結束。';
  table.round = newRound(table);
  table.phase = 'open';
  table.endsAt = Date.now() + table.settings.openSeconds * 1000;
  broadcastTable(table);
  Array.from(viewers.keys()).forEach(sendMe);
  return null;
}

function settle(table) {
  const round = table.round;
  const cards = cardMap(round);
  const check = Games.checkComplete(table.game, cards);
  if (!check.ok) {
    if (check.duplicate) return Games.cardLabel(check.duplicate) + ' 出現兩次。';
    if (check.missing.length) return '還缺：' + check.missing.map(function (zone) { return Games.zoneLabel(table.game, zone); }).join('、');
    return '依規則不該有牌：' + check.extra.map(function (zone) { return Games.zoneLabel(table.game, zone); }).join('、');
  }
  const outcome = table.game.outcome(cards);
  round.outcome = outcome;
  let staked = 0, returned = 0;
  round.picks.forEach(function (list, viewerId) {
    const viewer = viewers.get(viewerId);
    let mine = 0, back = 0;
    list.forEach(function (pick) { mine += pick.amount; back += table.game.returned(pick.spot, pick.amount, outcome); });
    if (viewer) viewer.points += back;
    staked += mine; returned += back;
    sendToViewer(viewerId, { t: 'result', table: table.id, roundNo: round.no, staked: mine, returned: back, text: outcome.text });
  });
  table.road.push(table.game.road(outcome));
  if (table.road.length > ROAD_LIMIT) table.road.shift();
  pushHistory(table, { roundNo: round.no, text: outcome.text, road: table.game.road(outcome), staked: staked, returned: returned });
  table.phase = 'result';
  table.endsAt = Date.now() + RESULT_HOLD_MS;
  broadcastTable(table);
  round.picks.forEach(function (list, viewerId) { sendMe(viewerId); });
  return null;
}

function voidRound(table) {
  if (['open', 'closed', 'dealing'].indexOf(table.phase) < 0) return '現在沒有進行中的回合。';
  const round = table.round;
  let staked = 0;
  round.picks.forEach(function (list, viewerId) {
    const viewer = viewers.get(viewerId);
    const mine = list.reduce(function (total, pick) { return total + pick.amount; }, 0);
    if (viewer) viewer.points += mine;
    staked += mine;
    sendToViewer(viewerId, { t: 'result', table: table.id, roundNo: round.no, staked: mine, returned: mine, text: '本回合已取消，點數全數退回' });
  });
  round.outcome = { winner: null, text: '已取消' };
  pushHistory(table, { roundNo: round.no, text: '已取消（退回 ' + staked + ' 點）', road: null, staked: staked, returned: staked });
  table.phase = 'void';
  table.endsAt = Date.now() + RESULT_HOLD_MS;
  broadcastTable(table);
  round.picks.forEach(function (list, viewerId) { sendMe(viewerId); });
  return null;
}

function pushHistory(table, entry) {
  const round = table.round;
  entry.at = Date.now();
  entry.cards = {};
  Object.keys(round.cards).forEach(function (zone) {
    const card = round.cards[zone];
    entry.cards[zone] = { card: card.card, source: card.source, score: card.score, shot: card.shot };
  });
  table.history.unshift(entry);
  if (table.history.length > HISTORY_LIMIT) table.history.length = HISTORY_LIMIT;
}

setInterval(function () {
  const now = Date.now();
  Object.keys(tables).forEach(function (id) {
    const table = tables[id];
    if (table.phase === 'open' && now >= table.endsAt) {
      table.phase = 'closed';
      table.endsAt = now + table.settings.waitSeconds * 1000;
      broadcastTable(table);
    } else if (table.phase === 'closed' && now >= table.endsAt) {
      table.phase = 'dealing';
      table.endsAt = 0;
      broadcastTable(table);
    } else if ((table.phase === 'result' || table.phase === 'void') && table.settings.auto && now >= table.endsAt) {
      openRound(table);
    }
  });
}, 200);

// Reader online/offline changes are shown on every page, so tell them when it flips.
let readerWasOnline = {};
setInterval(function () {
  Object.keys(tables).forEach(function (id) {
    const online = Date.now() - tables[id].readerSeenAt < READER_TIMEOUT_MS;
    if (online !== !!readerWasOnline[id]) { readerWasOnline[id] = online; broadcastTable(tables[id]); }
  });
}, 1000);

/* ------------------------------------------------------------------ messages in */

function handleViewer(socket, message) {
  const viewer = viewers.get(socket.viewerId);
  if (message.t === 'pick') {
    const table = tables[message.table];
    if (!table) return 'Unknown table.';
    if (table.phase !== 'open') return '現在不能選擇，請等下一回合。';
    const spot = table.game.spots.find(function (item) { return item.id === message.spot; });
    if (!spot) return 'Unknown spot.';
    const amount = Number(message.amount);
    if (CHIPS.indexOf(amount) < 0) return 'Unknown chip.';
    if (viewer.points < amount) return '點數不足。';
    const list = table.round.picks.get(viewer.id) || [];
    const onSpot = list.reduce(function (total, pick) { return total + (pick.spot === spot.id ? pick.amount : 0); }, 0);
    if (onSpot + amount > SPOT_LIMIT) return '這一格本回合最多 ' + SPOT_LIMIT + ' 點。';
    viewer.points -= amount;
    list.push({ spot: spot.id, amount: amount });
    table.round.picks.set(viewer.id, list);
    sendMe(viewer.id);
    broadcastTable(table);
    return null;
  }
  if (message.t === 'undo') {
    const table = tables[message.table];
    if (!table || table.phase !== 'open') return '現在不能撤回。';
    const list = table.round.picks.get(viewer.id);
    if (!list || !list.length) return null;
    const last = list.pop();
    viewer.points += last.amount;
    if (!list.length) table.round.picks.delete(viewer.id);
    sendMe(viewer.id);
    broadcastTable(table);
    return null;
  }
  if (message.t === 'refill') {
    if (viewer.points >= REFILL_BELOW) return '點數低於 ' + REFILL_BELOW + ' 才能補充。';
    viewer.points = START_POINTS;
    sendMe(viewer.id);
    return null;
  }
  if (message.t === 'rename') {
    viewer.name = cleanName(message.name) || viewer.name;
    sendMe(viewer.id);
    return null;
  }
  return 'Unknown message.';
}

function handleHost(socket, message) {
  const table = tables[message.table];
  if (!table) return 'Unknown table.';
  if (message.t === 'open') return openRound(table);
  if (message.t === 'void') return voidRound(table);
  if (message.t === 'confirm') {
    if (table.phase !== 'dealing') return '出牌階段才能確認結果。';
    return settle(table);
  }
  if (message.t === 'setCard') {
    if (table.phase !== 'dealing') return '出牌階段才能修改牌。';
    if (!table.game.zones.some(function (zone) { return zone.id === message.zone; })) return 'Unknown zone.';
    if (message.card === null) delete table.round.cards[message.zone];
    else if (Games.isCard(message.card)) table.round.cards[message.zone] = { card: message.card, source: 'manual', at: Date.now() };
    else return 'Unknown card.';
    markConflicts(table.round);
    broadcastTable(table);
    return null;
  }
  if (message.t === 'settings') {
    const open = Math.round(Number(message.openSeconds)), wait = Math.round(Number(message.waitSeconds));
    table.settings = {
      openSeconds: isFinite(open) ? Math.min(120, Math.max(5, open)) : table.settings.openSeconds,
      waitSeconds: isFinite(wait) ? Math.min(30, Math.max(0, wait)) : table.settings.waitSeconds,
      auto: !!message.auto
    };
    broadcastTable(table);
    return null;
  }
  return 'Unknown message.';
}

function markConflicts(round) {
  const seen = {};
  Object.keys(round.cards).forEach(function (zone) { const card = round.cards[zone].card; if (card) seen[card] = (seen[card] || 0) + 1; });
  Object.keys(round.cards).forEach(function (zone) { const entry = round.cards[zone]; entry.conflict = !!(entry.card && seen[entry.card] > 1); });
}

function handleReader(socket, message) {
  const table = tables[message.table];
  if (!table) return 'Unknown table.';
  table.readerSeenAt = Date.now();
  if (message.t === 'frame') {
    if (typeof message.image !== 'string' || message.image.indexOf('data:image/jpeg;base64,') !== 0) return null;
    table.frame = { image: message.image, at: Date.now() };
    if (Date.now() - table.frameSentAt >= FRAME_INTERVAL_MS) {
      table.frameSentAt = Date.now();
      sockets.forEach(function (other) { if (other.role && other.role !== 'reader' && other.watching === table.id) send(other, { t: 'frame', table: table.id, image: table.frame.image, at: table.frame.at }); });
    }
    return null;
  }
  if (message.t === 'status') {
    table.readerInfo = { text: String(message.text || '').slice(0, 120), at: Date.now() };
    return null;
  }
  if (message.t === 'zone') return readerZone(table, message);
  return 'Unknown message.';
}

// The reader reports what it now sees in one zone: a card, a card it is unsure about, or nothing.
function readerZone(table, message) {
  const round = table.round;
  const zone = message.zone;
  const label = Games.zoneLabel(table.game, zone);
  if (!table.game.zones.some(function (item) { return item.id === zone; })) return 'Unknown zone.';
  if (!round) return null;
  if (table.phase === 'open' || table.phase === 'closed') {
    if (message.state !== 'empty' && !round.warned['early-' + zone]) {
      round.warned['early-' + zone] = true;
      notifyStaff(table, 'warn', label + ' 在截止前就有牌，請確認沒有提早翻牌。');
    }
    return null;
  }
  if (table.phase !== 'dealing') return null;
  const existing = round.cards[zone];
  if (message.state === 'empty') {
    if (existing && existing.source === 'optical') { delete round.cards[zone]; markConflicts(round); broadcastTable(table); }
    return null;
  }
  if (existing && existing.source === 'manual') return null;   // the host's own choice wins over the camera
  const required = table.game.required(cardMap(round));
  if (!existing && required.indexOf(zone) < 0) {
    if (!round.warned['extra-' + zone]) { round.warned['extra-' + zone] = true; notifyStaff(table, 'warn', label + ' 現在不該出牌，這張沒有採用。'); }
    return null;
  }
  const shot = typeof message.shot === 'string' && message.shot.indexOf('data:image/jpeg;base64,') === 0 && message.shot.length < 60000 ? message.shot : null;
  const top = Array.isArray(message.top) ? message.top.slice(0, 3).filter(function (item) { return item && Games.isCard(item.card); }).map(function (item) { return { card: item.card, score: Number(item.score) || 0 }; }) : [];
  if (message.state === 'card' && Games.isCard(message.card)) {
    round.cards[zone] = { card: message.card, source: 'optical', score: Number(message.score) || 0, margin: Number(message.margin) || 0, top: top, shot: shot, at: Date.now() };
  } else {
    round.cards[zone] = { card: null, source: 'optical', uncertain: true, top: top, shot: shot, at: Date.now() };
    notifyStaff(table, 'warn', label + ' 認不出來，請手動選牌。');
  }
  markConflicts(round);
  if (round.cards[zone].conflict) notifyStaff(table, 'warn', Games.cardLabel(round.cards[zone].card) + ' 出現兩次，請檢查。');
  broadcastTable(table);
  return null;
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

function keyMatches(given) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(STAFF_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ http + websocket */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer(function (request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/healthz') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('ok'); return; }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (full.indexOf(PUBLIC_DIR) !== 0) { response.writeHead(403); response.end(); return; }
  fs.readFile(full, function (error, data) {
    if (error) { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(data);
  });
});

const wss = new WebSocketServer({ server: server, path: '/ws', maxPayload: 600 * 1024 });

wss.on('connection', function (socket) {
  socket.isAlive = true;
  socket.on('pong', function () { socket.isAlive = true; });
  sockets.add(socket);
  socket.on('close', function () { sockets.delete(socket); });
  socket.on('message', function (raw) {
    let message;
    try { message = JSON.parse(raw); } catch (error) { return; }
    if (!message || typeof message.t !== 'string') return;
    let problem = null;
    if (message.t === 'hello') problem = hello(socket, message);
    else if (message.t === 'watch') {
      if (!tables[message.table]) problem = 'Unknown table.';
      else {
        socket.watching = message.table;
        const table = tables[message.table];
        send(socket, { t: 'table', table: tableView(table, socket.role === 'viewer' ? 'viewer' : 'staff') });
        if (table.frame && socket.role !== 'reader') send(socket, { t: 'frame', table: table.id, image: table.frame.image, at: table.frame.at });
      }
    }
    else if (!socket.role) problem = 'Say hello first.';
    else if (socket.role === 'viewer') problem = handleViewer(socket, message);
    else if (socket.role === 'host') problem = handleHost(socket, message);
    else if (socket.role === 'reader') problem = handleReader(socket, message);
    if (problem) send(socket, { t: 'error', text: problem, ref: message.ref || null });
  });
});

function hello(socket, message) {
  if (message.role === 'host' || message.role === 'reader') {
    if (!keyMatches(message.key)) { send(socket, { t: 'denied' }); return null; }
    socket.role = message.role;
    send(socket, { t: 'welcome', role: socket.role, serverNow: Date.now(), tables: Object.keys(tables) });
    return null;
  }
  if (message.role === 'viewer') {
    const id = String(message.viewerId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || crypto.randomUUID();
    if (!viewers.has(id)) viewers.set(id, { id: id, name: cleanName(message.name) || ('觀眾' + id.slice(0, 4)), points: START_POINTS });
    socket.role = 'viewer';
    socket.viewerId = id;
    send(socket, { t: 'welcome', role: 'viewer', serverNow: Date.now(), tables: Object.keys(tables), chips: CHIPS, refillBelow: REFILL_BELOW });
    sendMe(id);
    return null;
  }
  return 'Unknown role.';
}

// Keep idle connections alive through Cloud Run and proxies, and drop dead ones.
setInterval(function () {
  sockets.forEach(function (socket) {
    if (!socket.isAlive) { socket.terminate(); return; }
    socket.isAlive = false;
    try { socket.ping(); } catch (error) { /* closing */ }
  });
}, 25000);

server.listen(PORT, function () { console.log('Tap Duel Live listening on ' + PORT); });

module.exports = { server: server, tables: tables, viewers: viewers };
