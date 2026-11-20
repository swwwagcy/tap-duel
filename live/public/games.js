// Game rules shared by the server (require) and every page (<script src="games.js">).
// One copy only: the server decides outcomes and pays out, the pages only display them.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Games = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUITS = ['S', 'H', 'D', 'C'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };

  function suitOf(card) { return card[0]; }
  function rankOf(card) { return card.slice(1); }
  function isCard(card) { return typeof card === 'string' && SUITS.indexOf(card[0]) >= 0 && RANKS.indexOf(card.slice(1)) >= 0; }
  function isRed(card) { return card[0] === 'H' || card[0] === 'D'; }
  function cardLabel(card) { return SUIT_SYMBOL[suitOf(card)] + rankOf(card); }
  function allCards() {
    var out = [];
    SUITS.forEach(function (suit) { RANKS.forEach(function (rank) { out.push(suit + rank); }); });
    return out;
  }
  function has(cards, zone) { return !!cards[zone]; }

  /* ---------------- Duel: one card each, higher rank wins ---------------- */
  var duelRank = function (card) { return RANKS.indexOf(rankOf(card)) + 1; };
  var duel = {
    id: 'duel',
    name: '對決',
    summary: '紅方、藍方各一張牌，點數大的一方勝。A 最小、K 最大，不比花色。',
    zones: [
      { id: 'R', label: '紅方', side: 'red' },
      { id: 'U', label: '藍方', side: 'blue' }
    ],
    // Where each card position sits on the camera image by default (fractions of the frame).
    layout: { R: [0.14, 0.22, 0.30, 0.56], U: [0.56, 0.22, 0.30, 0.56] },
    spots: [
      { id: 'R', label: '紅方', odds: '1 : 1', side: 'red' },
      { id: 'T', label: '平手', odds: '1 : 8', side: 'tie' },
      { id: 'U', label: '藍方', odds: '1 : 1', side: 'blue' }
    ],
    rules: [
      '紅方或藍方猜中，連本帶回 2 倍。',
      '平手猜中，連本帶回 9 倍。',
      '開出平手時，選紅方或藍方的退回一半。'
    ],
    required: function () { return ['R', 'U']; },
    outcome: function (cards) {
      var red = duelRank(cards.R), blue = duelRank(cards.U);
      var winner = red > blue ? 'R' : blue > red ? 'U' : 'T';
      return { winner: winner, text: winner === 'R' ? '紅方勝' : winner === 'U' ? '藍方勝' : '平手', detail: cardLabel(cards.R) + ' 對 ' + cardLabel(cards.U) };
    },
    // Total returned for a stake on a spot (0 when lost; includes the stake when won).
    returned: function (spot, amount, outcome) {
      if (spot === 'T') return outcome.winner === 'T' ? amount * 9 : 0;
      if (outcome.winner === 'T') return Math.floor(amount / 2);
      return outcome.winner === spot ? amount * 2 : 0;
    },
    road: function (outcome) { return outcome.winner; }
  };

  /* ---------------- Nine: closest to nine, fixed third-card rules ---------------- */
  var nineValue = function (card) { var index = RANKS.indexOf(rankOf(card)) + 1; return index >= 10 ? 0 : index; };
  var BASE = ['U1', 'R1', 'U2', 'R2'];
  function nineTotals(cards, blueZones, redZones) {
    var sum = function (zones) { return zones.reduce(function (total, zone) { return total + (cards[zone] ? nineValue(cards[zone]) : 0); }, 0) % 10; };
    return { blue: sum(blueZones), red: sum(redZones) };
  }
  // Red (the second hand) draws a third card when: total 0-2 always; 3 unless blue's third is 8;
  // 4 if blue's third is 2-7; 5 if 4-7; 6 if 6-7; never on 7.
  function redDrawsAfterBlueThird(redTotal, blueThird) {
    if (redTotal <= 2) return true;
    if (redTotal === 3) return blueThird !== 8;
    if (redTotal === 4) return blueThird >= 2 && blueThird <= 7;
    if (redTotal === 5) return blueThird >= 4 && blueThird <= 7;
    if (redTotal === 6) return blueThird === 6 || blueThird === 7;
    return false;
  }
  var nine = {
    id: 'nine',
    name: '九點',
    summary: '藍方、紅方各拿兩到三張牌，總和取個位數，越接近 9 的一方勝。是否補第三張由固定規則決定，系統會提示。',
    zones: [
      { id: 'U1', label: '藍方 1', side: 'blue' },
      { id: 'U2', label: '藍方 2', side: 'blue' },
      { id: 'U3', label: '藍方 3', side: 'blue' },
      { id: 'R1', label: '紅方 1', side: 'red' },
      { id: 'R2', label: '紅方 2', side: 'red' },
      { id: 'R3', label: '紅方 3', side: 'red' }
    ],
    layout: {
      U1: [0.05, 0.08, 0.13, 0.36], U2: [0.20, 0.08, 0.13, 0.36], U3: [0.35, 0.08, 0.13, 0.36],
      R1: [0.52, 0.56, 0.13, 0.36], R2: [0.67, 0.56, 0.13, 0.36], R3: [0.82, 0.56, 0.13, 0.36]
    },
    spots: [
      { id: 'blue', label: '藍方', odds: '1 : 1', side: 'blue' },
      { id: 'tie', label: '平手', odds: '1 : 8', side: 'tie' },
      { id: 'red', label: '紅方', odds: '1 : 0.95', side: 'red' },
      { id: 'bluePair', label: '藍方對子', odds: '1 : 11', side: 'blue' },
      { id: 'redPair', label: '紅方對子', odds: '1 : 11', side: 'red' }
    ],
    rules: [
      'A 算 1，2 到 9 照點數，10、J、Q、K 算 0，總和只看個位數。',
      '出牌順序：藍 1、紅 1、藍 2、紅 2。任一方前兩張是 8 或 9 就直接比。',
      '藍方 0 到 5 補第三張；紅方依自己的點數與藍方第三張決定是否補。',
      '藍方猜中連本帶回 2 倍；紅方猜中帶回 1.95 倍（無條件捨去）。',
      '平手猜中帶回 9 倍；開出平手時選藍方或紅方的全數退回。',
      '對子：該方前兩張點數相同（例如兩張 7），猜中帶回 12 倍。'
    ],
    required: function (cards) {
      if (!BASE.every(function (zone) { return has(cards, zone); })) return BASE.slice();
      var start = nineTotals(cards, ['U1', 'U2'], ['R1', 'R2']);
      if (start.blue >= 8 || start.red >= 8) return BASE.slice();
      if (start.blue <= 5) {
        if (!has(cards, 'U3')) return BASE.concat(['U3']);
        return redDrawsAfterBlueThird(start.red, nineValue(cards.U3)) ? BASE.concat(['U3', 'R3']) : BASE.concat(['U3']);
      }
      return start.red <= 5 ? BASE.concat(['R3']) : BASE.slice();
    },
    outcome: function (cards) {
      var totals = nineTotals(cards, ['U1', 'U2', 'U3'], ['R1', 'R2', 'R3']);
      var winner = totals.blue > totals.red ? 'blue' : totals.red > totals.blue ? 'red' : 'tie';
      var bluePair = rankOf(cards.U1) === rankOf(cards.U2);
      var redPair = rankOf(cards.R1) === rankOf(cards.R2);
      var text = (winner === 'blue' ? '藍方勝' : winner === 'red' ? '紅方勝' : '平手') + '（藍 ' + totals.blue + ' : 紅 ' + totals.red + '）';
      var extras = [];
      if (bluePair) extras.push('藍方對子');
      if (redPair) extras.push('紅方對子');
      return { winner: winner, blue: totals.blue, red: totals.red, bluePair: bluePair, redPair: redPair, text: text + (extras.length ? '・' + extras.join('・') : ''), detail: '' };
    },
    returned: function (spot, amount, outcome) {
      if (spot === 'bluePair') return outcome.bluePair ? amount * 12 : 0;
      if (spot === 'redPair') return outcome.redPair ? amount * 12 : 0;
      if (spot === 'tie') return outcome.winner === 'tie' ? amount * 9 : 0;
      if (outcome.winner === 'tie') return amount;
      if (spot === 'blue') return outcome.winner === 'blue' ? amount * 2 : 0;
      if (spot === 'red') return outcome.winner === 'red' ? amount + Math.floor(amount * 0.95) : 0;
      return 0;
    },
    road: function (outcome) { return outcome.winner === 'blue' ? 'U' : outcome.winner === 'red' ? 'R' : 'T'; }
  };

  var GAMES = { duel: duel, nine: nine };

  // Which zone the host should fill next, or null when the required set is complete.
  function nextZone(game, cards) {
    var required = game.required(cards);
    for (var index = 0; index < required.length; index++) if (!cards[required[index]]) return required[index];
    return null;
  }
  // The cards on the table must be exactly the ones the rules call for: no missing card, no extra card.
  function checkComplete(game, cards) {
    var required = game.required(cards);
    var missing = required.filter(function (zone) { return !cards[zone]; });
    var extra = Object.keys(cards).filter(function (zone) { return cards[zone] && required.indexOf(zone) < 0; });
    var seen = {}, duplicate = null;
    Object.keys(cards).forEach(function (zone) { var card = cards[zone]; if (!card) return; if (seen[card]) duplicate = card; seen[card] = true; });
    return { ok: !missing.length && !extra.length && !duplicate, missing: missing, extra: extra, duplicate: duplicate };
  }
  function zoneLabel(game, zone) {
    for (var index = 0; index < game.zones.length; index++) if (game.zones[index].id === zone) return game.zones[index].label;
    return zone;
  }

  return {
    SUITS: SUITS, RANKS: RANKS, SUIT_SYMBOL: SUIT_SYMBOL, GAMES: GAMES,
    suitOf: suitOf, rankOf: rankOf, isCard: isCard, isRed: isRed, cardLabel: cardLabel, allCards: allCards,
    nextZone: nextZone, checkComplete: checkComplete, zoneLabel: zoneLabel
  };
});
