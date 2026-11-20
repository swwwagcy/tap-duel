// Reads a playing card with no knowledge of the deck: it cuts the rank and the suit symbol out of
// the card's corner index and compares their shapes with built-in references (the thirteen ranks
// drawn in several typefaces, the four suits drawn as shapes and as font symbols). Colour is never
// used to decide the suit, so decks with teal diamonds or four-colour suits read the same way.
// Needs a browser (canvas) to draw the references.
(function (root) {
  'use strict';

  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['S', 'H', 'D', 'C'];
  var CORNER_U = 0.30, CORNER_V = 0.42;       // part of the card searched for the index
  var CORNER_W = 84, CORNER_H = 164;          // how finely that part is sampled
  var GLYPH_W = 20, GLYPH_H = 28;             // every cut-out shape is stretched to this size
  var LIMITS = { score: 0.62, margin: 0.3 };

  /* ---------------- small helpers ---------------- */

  function normalise(values) {
    var mean = 0, index;
    for (index = 0; index < values.length; index++) mean += values[index];
    mean /= values.length;
    var out = new Float32Array(values.length), norm = 0;
    for (index = 0; index < values.length; index++) { out[index] = values[index] - mean; norm += out[index] * out[index]; }
    norm = Math.sqrt(norm) || 1;
    for (index = 0; index < values.length; index++) out[index] /= norm;
    return out;
  }
  function dot(a, b) { var total = 0; for (var index = 0; index < a.length; index++) total += a[index] * b[index]; return total; }
  function blur(values, width, height) {
    var out = new Float32Array(values.length);
    for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
      var total = 0, count = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        var weight = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
        total += values[yy * width + xx] * weight; count += weight;
      }
      out[y * width + x] = total / count;
    }
    return out;
  }
  // Otsu's threshold over values in 0..255.
  function otsu(values) {
    var histogram = new Float64Array(256), index, sum = 0;
    for (index = 0; index < values.length; index++) histogram[Math.max(0, Math.min(255, values[index] | 0))]++;
    for (index = 0; index < 256; index++) sum += index * histogram[index];
    var below = 0, weight = 0, best = -1, threshold = 128;
    for (index = 0; index < 256; index++) {
      weight += histogram[index];
      if (!weight) continue;
      var rest = values.length - weight;
      if (!rest) break;
      below += index * histogram[index];
      var gap = below / weight - (sum - below) / rest, between = weight * rest * gap * gap;
      if (between > best) { best = between; threshold = index; }
    }
    return threshold;
  }

  // Stretches the ink inside box to GLYPH_W x GLYPH_H, softens it and makes it comparable.
  function glyphVector(ink, width, box) {
    var out = new Float32Array(GLYPH_W * GLYPH_H), bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    for (var oy = 0; oy < GLYPH_H; oy++) for (var ox = 0; ox < GLYPH_W; ox++) {
      var total = 0;
      for (var j = 0; j < 3; j++) for (var i = 0; i < 3; i++) {
        var x = Math.min(box.x1, Math.floor(box.x0 + (ox + (i + 0.5) / 3) * bw / GLYPH_W));
        var y = Math.min(box.y1, Math.floor(box.y0 + (oy + (j + 0.5) / 3) * bh / GLYPH_H));
        total += ink[y * width + x];
      }
      out[oy * GLYPH_W + ox] = total / 9;
    }
    return normalise(blur(out, GLYPH_W, GLYPH_H));
  }

  // Connected pieces of ink (8-connected): [{ x0, y0, x1, y1, area }].
  function components(ink, width, height) {
    var seen = new Uint8Array(width * height), found = [], stack = [];
    for (var start = 0; start < ink.length; start++) {
      if (!ink[start] || seen[start]) continue;
      var box = { x0: width, y0: height, x1: -1, y1: -1, area: 0 };
      stack.push(start); seen[start] = 1;
      while (stack.length) {
        var at = stack.pop(), x = at % width, y = (at - x) / width;
        box.area++;
        if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x; if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          var next = ny * width + nx;
          if (ink[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
      found.push(box);
    }
    return found;
  }
  function union(a, b) { return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area: a.area + b.area }; }

  /* ---------------- references ---------------- */

  var FONTS = ['Arial, Helvetica, sans-serif', 'Georgia, "Times New Roman", serif', '"Courier New", monospace', 'Impact, "Arial Narrow", sans-serif', 'Verdana, sans-serif'];
  var references = null;

  function inkOf(canvas) {
    var context = canvas.getContext('2d'), data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    var ink = new Uint8Array(canvas.width * canvas.height), box = { x0: canvas.width, y0: canvas.height, x1: -1, y1: -1 };
    for (var index = 0; index < ink.length; index++) {
      if (data[index * 4] < 128) {
        ink[index] = 1;
        var x = index % canvas.width, y = (index - x) / canvas.width;
        if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x; if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
      }
    }
    return box.x1 < 0 ? null : glyphVector(ink, canvas.width, box);
  }
  function blank(size) {
    var canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff'; context.fillRect(0, 0, size, size); context.fillStyle = '#000';
    context.textAlign = 'center'; context.textBaseline = 'middle';
    return { canvas: canvas, context: context };
  }
  function drawnText(text, font, weight) {
    var sheet = blank(160);
    sheet.context.font = weight + ' 80px ' + font;
    sheet.context.fillText(text, 80, 80);
    return inkOf(sheet.canvas);
  }
  // The four suits drawn as plain shapes, so reading does not depend on which fonts a phone has.
  function drawnSuit(suit, variant) {
    var sheet = blank(160), c = sheet.context, plump = variant ? 1.12 : 1;
    c.translate(80, 80); c.scale(plump, 1);
    function heart(flip) {
      c.save(); if (flip) c.scale(1, -1);
      c.beginPath(); c.moveTo(0, 46);
      c.bezierCurveTo(-18, 26, -52, 6, -52, -20); c.bezierCurveTo(-52, -52, -12, -54, 0, -26);
      c.bezierCurveTo(12, -54, 52, -52, 52, -20); c.bezierCurveTo(52, 6, 18, 26, 0, 46);
      c.fill(); c.restore();
    }
    function stem() { c.beginPath(); c.moveTo(0, 6); c.quadraticCurveTo(-2, 40, -18, 54); c.lineTo(18, 54); c.quadraticCurveTo(2, 40, 0, 6); c.fill(); }
    if (suit === 'H') heart(false);
    else if (suit === 'D') { c.beginPath(); c.moveTo(0, -54); c.quadraticCurveTo(18, -22, 40, 0); c.quadraticCurveTo(18, 22, 0, 54); c.quadraticCurveTo(-18, 22, -40, 0); c.quadraticCurveTo(-18, -22, 0, -54); c.fill(); }
    else if (suit === 'S') { c.translate(0, -8); heart(true); stem(); }
    else { [[0, -28], [-26, 8], [26, 8]].forEach(function (p) { c.beginPath(); c.arc(p[0], p[1], 22, 0, Math.PI * 2); c.fill(); }); c.fillRect(-6, -8, 12, 20); stem(); }
    return inkOf(sheet.canvas);
  }
  function build() {
    if (references) return references;
    var ranks = [], suits = [], symbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
    RANKS.forEach(function (rank) {
      FONTS.forEach(function (font) { ['400', '700'].forEach(function (weight) { var vector = drawnText(rank, font, weight); if (vector) ranks.push({ key: rank, vector: vector }); }); });
    });
    SUITS.forEach(function (suit) {
      [0, 1].forEach(function (variant) { suits.push({ key: suit, vector: drawnSuit(suit, variant) }); });
      ['Arial, sans-serif', 'Georgia, serif'].forEach(function (font) { var vector = drawnText(symbols[suit], font, '400'); if (vector) suits.push({ key: suit, vector: vector }); });
    });
    references = { ranks: ranks, suits: suits };
    return references;
  }

  // Best reference per class, sorted. The margin looks only at where the two leading classes'
  // references differ (a spade and a club agree on most pixels): +1 means the shape is exactly the
  // leader's reference, 0 means it sits halfway between the two.
  function classify(vector, list) {
    var best = {};
    list.forEach(function (reference) { var score = dot(vector, reference.vector); if (!(reference.key in best) || score > best[reference.key].score) best[reference.key] = { key: reference.key, score: score, vector: reference.vector }; });
    var sorted = Object.keys(best).map(function (key) { return best[key]; }).sort(function (a, b) { return b.score - a.score; });
    var first = sorted[0], second = sorted[1], margin = 1;
    if (second) { var alike = dot(first.vector, second.vector); margin = alike > 0.995 ? 0 : (first.score - second.score) / (1 - alike); }
    return { key: first.key, score: first.score, margin: margin, second: second ? second.key : null };
  }

  /* ---------------- reading one corner ---------------- */

  function rgbAt(frame, x, y, out) {
    var px = x < 0 ? 0 : x > frame.width - 1 ? frame.width - 1 : x | 0, py = y < 0 ? 0 : y > frame.height - 1 ? frame.height - 1 : y | 0;
    var index = (py * frame.width + px) * 4, data = frame.data;
    out[0] = data[index]; out[1] = data[index + 1]; out[2] = data[index + 2];
  }

  // card: { cx, cy, w, h, angle } as found by Recognizer.locate. flip reads the opposite corner.
  // Returns { rank, suit, card } with scores, or { problem } when no index could be cut out.
  function readCorner(frame, card, flip) {
    var cos = Math.cos(card.angle), sin = Math.sin(card.angle), sign = flip ? -1 : 1, pixel = [0, 0, 0];
    var colours = new Uint8Array(CORNER_W * CORNER_H * 3), luma = new Float32Array(CORNER_W * CORNER_H);
    for (var oy = 0; oy < CORNER_H; oy++) for (var ox = 0; ox < CORNER_W; ox++) {
      var r = 0, g = 0, b = 0;
      for (var j = 0; j < 2; j++) for (var i = 0; i < 2; i++) {
        var u = CORNER_U * (ox + (i + 0.5) / 2) / CORNER_W, v = CORNER_V * (oy + (j + 0.5) / 2) / CORNER_H;
        var lx = sign * (u - 0.5) * card.w, ly = sign * (v - 0.5) * card.h;
        rgbAt(frame, card.cx + lx * cos - ly * sin, card.cy + lx * sin + ly * cos, pixel);
        r += pixel[0]; g += pixel[1]; b += pixel[2];
      }
      var at = oy * CORNER_W + ox;
      colours[at * 3] = r / 4; colours[at * 3 + 1] = g / 4; colours[at * 3 + 2] = b / 4;
      luma[at] = (0.299 * r + 0.587 * g + 0.114 * b) / 4;
    }
    // Paper colour: the average of the brighter half of the corner. Ink: far from that colour.
    var sorted = Array.prototype.slice.call(luma).sort(function (a, b) { return a - b; }), median = sorted[sorted.length >> 1];
    var paper = [0, 0, 0], count = 0;
    for (at = 0; at < luma.length; at++) if (luma[at] >= median) { paper[0] += colours[at * 3]; paper[1] += colours[at * 3 + 1]; paper[2] += colours[at * 3 + 2]; count++; }
    paper = paper.map(function (value) { return value / count; });
    var distance = new Float32Array(luma.length);
    for (at = 0; at < luma.length; at++) distance[at] = Math.min(255, (Math.abs(colours[at * 3] - paper[0]) + Math.abs(colours[at * 3 + 1] - paper[1]) + Math.abs(colours[at * 3 + 2] - paper[2])) / 2);
    var threshold = Math.max(28, otsu(distance));
    var ink = new Uint8Array(luma.length);
    for (at = 0; at < luma.length; at++) ink[at] = distance[at] > threshold ? 1 : 0;

    // Keep pieces that can be part of an index: not touching the card's edge (that is the table
    // showing round the rounded corner, or the zone frame), not specks, not long rules or frames.
    var pieces = components(ink, CORNER_W, CORNER_H).filter(function (box) {
      var w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
      if (box.x0 <= 1 || box.y0 <= 1 || box.x1 >= CORNER_W - 2) return false;   // cut off by the edge: not an index
      if (box.area < 14 || h < 7) return false;
      if (w > CORNER_W * 0.7 || h > CORNER_H * 0.45) return false;
      if (h / w > 7 && w < 4) return false;
      return true;
    }).sort(function (a, b) { return a.y0 - b.y0; });
    if (!pieces.length) return { problem: 'no index found' };

    // The rank is the topmost piece, plus anything beside it on the same line (the two digits of 10).
    var rank = pieces[0], used = [0];
    for (var index = 1; index < pieces.length; index++) {
      var piece = pieces[index], overlap = Math.min(rank.y1, piece.y1) - Math.max(rank.y0, piece.y0) + 1;
      var height = rank.y1 - rank.y0 + 1, gap = Math.max(piece.x0 - rank.x1, rank.x0 - piece.x1);
      if (overlap > 0.5 * Math.min(height, piece.y1 - piece.y0 + 1) && gap < height * 0.45) { rank = union(rank, piece); used.push(index); }
    }
    // The suit is the nearest piece below the rank, in the same column.
    var rankHeight = rank.y1 - rank.y0 + 1, rankMiddle = (rank.x0 + rank.x1) / 2, rankWidth = rank.x1 - rank.x0 + 1, suit = null;
    for (index = 0; index < pieces.length; index++) {
      if (used.indexOf(index) >= 0) continue;
      piece = pieces[index];
      var middle = (piece.x0 + piece.x1) / 2;
      if (piece.y0 < rank.y1 - 2 || piece.y0 - rank.y1 > rankHeight * 1.3) continue;
      if (Math.abs(middle - rankMiddle) > Math.max(rankWidth, rankHeight * 0.5)) continue;
      if (!suit) { suit = piece; continue; }
      // More pieces at the same height belong to the same symbol (a club broken into lobes).
      if (piece.y0 <= suit.y1 + 1 && Math.max(piece.x0 - suit.x1, suit.x0 - piece.x1) <= 2) suit = union(suit, piece);
    }
    if (!suit) return { problem: 'no suit under the rank' };
    var suitHeight = suit.y1 - suit.y0 + 1;
    if (suitHeight < rankHeight * 0.35 || suitHeight > rankHeight * 1.8) return { problem: 'suit size does not fit the rank' };

    var refs = build();
    var rankRead = classify(glyphVector(ink, CORNER_W, rank), refs.ranks), suitRead = classify(glyphVector(ink, CORNER_W, suit), refs.suits);
    // Two separate pieces side by side can only be a 10; a single piece can never be one.
    var parts = used.length;
    if (parts >= 2 && rankRead.key !== '10') { rankRead = { key: '10', score: Math.max(0.7, rankRead.score), margin: 0.5, second: rankRead.key }; }
    return { rank: rankRead, suit: suitRead, card: suitRead.key + rankRead.key, boxes: { rank: rank, suit: suit } };
  }

  // Reads both corner indexes. sure: both corners give the same card, each clearly.
  function read(frame, card, limits) {
    limits = limits || LIMITS;
    var corners = [readCorner(frame, card, false), readCorner(frame, card, true)];
    var good = corners.filter(function (corner) { return !corner.problem; });
    if (!good.length) return { card: null, sure: false, score: 0, margin: 0, top: [], problem: corners[0].problem };
    var clear = function (corner) { return corner.rank.score >= limits.score && corner.suit.score >= limits.score && corner.rank.margin >= limits.margin && corner.suit.margin >= limits.margin; };
    var strength = function (corner) { return Math.min(corner.rank.score, corner.suit.score); };
    good.sort(function (a, b) { return strength(b) - strength(a); });
    var lead = good[0], agree = good.length === 2 && good[0].card === good[1].card;
    var top = [], seen = {};
    good.forEach(function (corner) {
      [corner.card, corner.suit.key + (corner.rank.second || corner.rank.key), (corner.suit.second || corner.suit.key) + corner.rank.key].forEach(function (candidate) {
        if (!seen[candidate] && top.length < 3) { seen[candidate] = true; top.push({ card: candidate, score: strength(corner) }); }
      });
    });
    return {
      card: lead.card, score: strength(lead), margin: Math.min(lead.rank.margin, lead.suit.margin), top: top, agree: agree,
      sure: agree && good.every(clear),
      problem: good.length < 2 ? 'only one corner readable' : !agree ? 'corners disagree' : ''
    };
  }

  root.CardOCR = { read: read, readCorner: readCorner, build: build, LIMITS: LIMITS };
})(typeof self !== 'undefined' ? self : this);
