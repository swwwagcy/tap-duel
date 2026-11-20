// The whole game server without any transport: tables, viewers' points, round flow, settlement.
// server.js runs it behind WebSockets on Cloud Run; demo mode runs the very same code inside the
// browser (demo-worker.js), so there is one set of rules, not two.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./games.js'));
  else root.Engine = factory(root.Games);
})(typeof self !== 'undefined' ? self : this, function (Games) {
  'use strict';

  // options: staffKeyMatches(key) -> boolean, newId() -> string, bots: number of demo viewers,
  // tableSettings: starting settings for every table.
  function createEngine(options) {
    options = options || {};
    const staffKeyMatches = options.staffKeyMatches || function () { return false; };
    const newId = options.newId || function () { return 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36); };
    const timers = [];

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
        settings: Object.assign({ openSeconds: 15, waitSeconds: 3, auto: false }, options.tableSettings || {}),
        history: [],
        road: [],
        frame: null,
        frameSentAt: 0,
        readerSeenAt: 0,
        readerInfo: null,
        seen: {}              // zone -> what the reader last saw there, in any phase
      };
    });
    const viewers = new Map();           // viewerId -> { id, name, points }
    const connections = new Set();       // every open connection: { deliver(message), role, watching, viewerId }

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
      try { socket.deliver(message); } catch (error) { /* the connection is going away */ }
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
            ? { card: entry.card, source: entry.source, back: entry.back }
            : { card: entry.card, source: entry.source, back: entry.back, score: entry.score, margin: entry.margin, top: entry.top, shot: entry.shot, uncertain: entry.uncertain, conflict: entry.conflict };
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
        stale: ['idle', 'result', 'void'].indexOf(table.phase) >= 0 ? staleZones(table) : [],
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
      connections.forEach(function (socket) {
        if (!socket.role || socket.watching !== table.id) return;
        send(socket, { t: 'table', table: tableView(table, socket.role === 'viewer' ? 'viewer' : 'staff') });
      });
    }

    // Picks arrive in bursts (every viewer at once near the end of the countdown). Running totals are
    // sent at most every 250 ms instead of once per pick; phase changes still go out immediately.
    const TOTALS_INTERVAL_MS = 250;
    function broadcastSoon(table) {
      if (table.broadcastTimer) return;
      table.broadcastTimer = setTimeout(function () { table.broadcastTimer = null; broadcastTable(table); }, TOTALS_INTERVAL_MS);
    }

    function notifyStaff(table, level, text) {
      connections.forEach(function (socket) {
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
      connections.forEach(function (socket) {
        if (socket.role === 'viewer' && socket.viewerId === viewerId) send(socket, { t: 'me', id: viewer.id, name: viewer.name, points: viewer.points, picks: picks });
      });
    }

    function sendToViewer(viewerId, message) {
      connections.forEach(function (socket) { if (socket.role === 'viewer' && socket.viewerId === viewerId) send(socket, message); });
    }

    /* ------------------------------------------------------------------ round flow */

    // Positions where the reader still sees a face-up (or unreadable) card. Between rounds these
    // are last round's cards: left there, they would be read as the new round's cards the moment
    // dealing starts. Face-down cards are fine; they are the next round's, placed early.
    function staleZones(table) {
      if (Date.now() - table.readerSeenAt >= READER_TIMEOUT_MS) return [];
      return table.game.zones.map(function (zone) { return zone.id; }).filter(function (zone) { return table.seen[zone] === 'card' || table.seen[zone] === 'unsure'; });
    }

    function openRound(table, force) {
      if (['idle', 'result', 'void'].indexOf(table.phase) < 0) return '這一回合還沒結束。';
      const stale = staleZones(table);
      if (stale.length && !force) return '桌上還有上一回合的牌（' + stale.map(function (zone) { return Games.zoneLabel(table.game, zone); }).join('、') + '），請先收掉。';
      table.round = newRound(table);
      table.phase = 'open';
      table.endsAt = Date.now() + table.settings.openSeconds * 1000;
      broadcastTable(table);
      Array.from(viewers.keys()).forEach(sendMe);
      scheduleBots(table);
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

    timers.push(setInterval(function () {
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
        } else if ((table.phase === 'result' || table.phase === 'void') && table.settings.auto && now >= table.endsAt && !staleZones(table).length) {
          openRound(table);   // waits for the table to be cleared
        }
      });
    }, 200));

    // Reader online/offline changes are shown on every page, so tell them when it flips.
    let readerWasOnline = {};
    timers.push(setInterval(function () {
      Object.keys(tables).forEach(function (id) {
        const online = Date.now() - tables[id].readerSeenAt < READER_TIMEOUT_MS;
        if (online !== !!readerWasOnline[id]) { readerWasOnline[id] = online; broadcastTable(tables[id]); }
      });
    }, 1000));

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
        broadcastSoon(table);
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
        broadcastSoon(table);
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
      if (message.t === 'open') return openRound(table, !!message.force);
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
          connections.forEach(function (other) { if (other.role && other.role !== 'reader' && other.watching === table.id) send(other, { t: 'frame', table: table.id, image: table.frame.image, at: table.frame.at }); });
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
      if (table.seen[zone] !== message.state) {
        table.seen[zone] = message.state;
        if (['idle', 'result', 'void'].indexOf(table.phase) >= 0) broadcastSoon(table);   // the host watches the table being cleared
      }
      if (!round) return null;
      const existing = round.cards[zone];
      // Before dealing, cards may already lie face down. A face-down card is shown as such; a card
      // that can be read this early was turned over too soon, and its value is not recorded.
      if (table.phase === 'open' || table.phase === 'closed') {
        if (message.state === 'back') {
          if (!existing) { round.cards[zone] = { card: null, source: 'optical', back: true, at: Date.now() }; broadcastTable(table); }
        } else if (message.state === 'empty') {
          if (existing) { delete round.cards[zone]; broadcastTable(table); }
        } else if (!round.warned['early-' + zone]) {
          round.warned['early-' + zone] = true;
          notifyStaff(table, 'warn', label + ' 在截止前就翻開了，請確認。');
        }
        return null;
      }
      if (table.phase !== 'dealing') return null;
      if (message.state === 'empty') {
        if (existing && existing.source === 'optical') { delete round.cards[zone]; markConflicts(round); broadcastTable(table); }
        return null;
      }
      if (existing && existing.source === 'manual') return null;   // the host's own choice wins over the camera
      if (message.state === 'back') {
        if (!existing || !existing.back) { round.cards[zone] = { card: null, source: 'optical', back: true, at: Date.now() }; markConflicts(round); broadcastTable(table); }
        return null;
      }
      if (existing && existing.back) delete round.cards[zone];      // it has been turned over
      const required = table.game.required(cardMap(round));
      if ((!existing || existing.back) && required.indexOf(zone) < 0) {
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


    function hello(socket, message) {
      if (message.role === 'host' || message.role === 'reader') {
        if (!staffKeyMatches(message.key)) { send(socket, { t: 'denied' }); return null; }
        socket.role = message.role;
        send(socket, { t: 'welcome', role: socket.role, serverNow: Date.now(), tables: Object.keys(tables) });
        return null;
      }
      if (message.role === 'viewer') {
        const id = String(message.viewerId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || newId();
        if (!viewers.has(id)) viewers.set(id, { id: id, name: cleanName(message.name) || ('觀眾' + id.slice(0, 4)), points: START_POINTS });
        socket.role = 'viewer';
        socket.viewerId = id;
        send(socket, { t: 'welcome', role: 'viewer', serverNow: Date.now(), tables: Object.keys(tables), chips: CHIPS, refillBelow: REFILL_BELOW });
        sendMe(id);
        return null;
      }
      return 'Unknown role.';
    }


    function receive(socket, raw) {
      let message;
      if (typeof raw === 'string') { try { message = JSON.parse(raw); } catch (error) { return; } } else message = raw;
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
    }

    /* ------------------------------------------------------------------ demo viewers */

    // Demo viewers make a few random picks at random moments of every countdown, so a table opened
    // by one person still looks like a table with an audience.
    const BOT_NAMES = ['示範觀眾 A', '示範觀眾 B', '示範觀眾 C', '示範觀眾 D', '示範觀眾 E', '示範觀眾 F', '示範觀眾 G', '示範觀眾 H'];
    const bots = [];
    for (let index = 0; index < Math.min(options.bots || 0, BOT_NAMES.length); index++) {
      const id = 'bot-' + index;
      viewers.set(id, { id: id, name: BOT_NAMES[index], points: START_POINTS });
      bots.push({ viewerId: id });
    }
    function scheduleBots(table) {
      if (!bots.length) return;
      const span = Math.max(1000, table.settings.openSeconds * 1000 - 800);
      bots.forEach(function (bot) {
        const viewer = viewers.get(bot.viewerId);
        if (viewer.points < REFILL_BELOW) viewer.points = START_POINTS;
        const picks = Math.floor(Math.random() * 3);
        for (let count = 0; count < picks; count++) {
          timers.push(setTimeout(function () {
            if (table.phase !== 'open') return;
            const spots = table.game.spots, weights = spots.map(function (spot) { return spot.side === 'tie' || /Pair/.test(spot.id) ? 1 : 4; });
            let roll = Math.random() * weights.reduce(function (a, b) { return a + b; }, 0), chosen = spots[0];
            for (let index = 0; index < spots.length; index++) { roll -= weights[index]; if (roll <= 0) { chosen = spots[index]; break; } }
            handleViewer(bot, { t: 'pick', table: table.id, spot: chosen.id, amount: CHIPS[Math.floor(Math.random() * 3)] });
          }, 300 + Math.random() * span));
        }
      });
    }

    return {
      tables: tables,
      viewers: viewers,
      connections: connections,
      connect: function (connection) { connections.add(connection); },
      disconnect: function (connection) { connections.delete(connection); },
      receive: receive,
      stop: function () { timers.forEach(function (timer) { clearInterval(timer); clearTimeout(timer); }); }
    };
  }

  // Settings for demo mode (in the browser, no staff key, a few demo viewers, faster rounds).
  // demo-worker.js and demo.html both use this one copy.
  const DEMO_OPTIONS = { staffKeyMatches: function () { return true; }, bots: 5, tableSettings: { openSeconds: 12, waitSeconds: 2, auto: true } };

  return { createEngine: createEngine, DEMO_OPTIONS: DEMO_OPTIONS };
});
